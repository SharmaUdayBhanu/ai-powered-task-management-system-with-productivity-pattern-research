import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import mongoose from "mongoose";
import dotenv from "dotenv";
import http from "http";
import { Server as SocketIOServer } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";

import { Employee, Admin } from "./models.js";
import geminiRouter from "./api/gemini/geminiRoutes.js";
import productivityRouter from "./api/productivityRoutes.js";
import {
  callGemini,
  safeParseJson,
  recordAiFallback,
} from "./api/gemini/geminiClient.js";
import {
  buildPriorityPrompt,
  buildExplainTaskPrompt,
  buildRuleBasedTaskGuidance,
} from "./api/gemini/geminiPrompts.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
let dbConnectPromise = null;
let lastDbConnectError = null;
let lastDbConnectAt = null;

const redactMongoUri = (uri = "") => {
  try {
    const normalized = String(uri || "").trim();
    if (!normalized) return "<missing>";

    return normalized.replace(
      /(mongodb(?:\+srv)?:\/\/)([^:]+):([^@]+)@/i,
      "$1$2:***@",
    );
  } catch {
    return "<unavailable>";
  }
};

const serializeError = (err) => ({
  name: err?.name || "Error",
  message: err?.message || "Unknown error",
  code: err?.code || null,
  stackTop: String(err?.stack || "")
    .split("\n")
    .slice(0, 2)
    .join(" | "),
});

const toTaskDeadline = (taskDateValue) => {
  if (!taskDateValue) return null;
  const deadline = new Date(taskDateValue);
  if (Number.isNaN(deadline.getTime())) return null;
  if (
    typeof taskDateValue === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(taskDateValue)
  ) {
    deadline.setHours(23, 59, 59, 999);
  }
  return deadline;
};

const computeOnTime = (completedAt, taskDateValue) => {
  const deadline = toTaskDeadline(taskDateValue);
  if (!completedAt) return null;
  if (!deadline) return null;
  return new Date(completedAt) <= deadline;
};

const buildTaskIdentityKey = (task = {}) => {
  if (task?._id) return String(task._id);
  return [
    String(task?.taskTitle || ""),
    String(task?.taskDate || ""),
    String(task?.taskDescription || ""),
  ].join("::");
};

const resolveTaskStartTime = (task = {}) => {
  const startSource =
    task.startedAt || task.acceptedAt || task.createdAt || task.assignedAt;
  if (!startSource || !isValidDate(startSource)) return null;
  return new Date(startSource);
};

const resolveCompletionTimeMinutes = (task = {}, completedAt) => {
  const explicit = Number(task.completionTime);
  if (Number.isFinite(explicit) && explicit >= 0) {
    return Math.max(0, Math.round(explicit));
  }

  if (completedAt && isValidDate(completedAt)) {
    const startTime = resolveTaskStartTime(task);
    if (startTime) {
      const diff = Math.round(
        (new Date(completedAt).getTime() - startTime.getTime()) / 60000,
      );
      return Math.max(0, diff);
    }
  }

  const estimated = Number(task.estimatedDuration);
  if (Number.isFinite(estimated) && estimated > 0) {
    return Math.max(0, Math.round(estimated));
  }

  return 0;
};

const isValidDate = (value) => {
  const date = new Date(value);
  return !Number.isNaN(date.getTime());
};

const computeTaskCounts = (tasks = []) => ({
  active: tasks.filter((t) => t.active && !t.isDeleted && !t.notAccepted)
    .length,
  newTask: tasks.filter((t) => t.newTask && !t.isDeleted && !t.notAccepted)
    .length,
  completed: tasks.filter((t) => t.completed && !t.isDeleted && !t.notAccepted)
    .length,
  failed: tasks.filter((t) => t.failed && !t.isDeleted && !t.notAccepted)
    .length,
});

const clampDurationMinutes = (minutes) => {
  const numeric = Number(minutes);
  if (!Number.isFinite(numeric)) return null;
  return Math.max(10, Math.min(480, Math.round(numeric)));
};

const parseDurationStringToMinutes = (value) => {
  const text = String(value || "")
    .toLowerCase()
    .trim();
  if (!text) return null;

  const hourMinuteMatch = text.match(
    /(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)\s*(\d+(?:\.\d+)?)?\s*(?:m|min|mins|minute|minutes)?/,
  );
  if (hourMinuteMatch) {
    const hours = Number(hourMinuteMatch[1]) || 0;
    const minutes = Number(hourMinuteMatch[2]) || 0;
    return clampDurationMinutes(hours * 60 + minutes);
  }

  const rangeMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:-|to)\s*(\d+(?:\.\d+)?)/);
  if (rangeMatch) {
    const first = Number(rangeMatch[1]);
    const second = Number(rangeMatch[2]);
    if (Number.isFinite(first) && Number.isFinite(second)) {
      const average = (first + second) / 2;
      const isHours = /(hour|hours|hr|hrs)\b/.test(text);
      return clampDurationMinutes(isHours ? average * 60 : average);
    }
  }

  const minutesMatch = text.match(
    /(\d+(?:\.\d+)?)\s*(?:m|min|mins|minute|minutes)\b/,
  );
  if (minutesMatch) {
    return clampDurationMinutes(Number(minutesMatch[1]));
  }

  const hoursMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)\b/);
  if (hoursMatch) {
    return clampDurationMinutes(Number(hoursMatch[1]) * 60);
  }

  const numericOnlyMatch = text.match(/\d+(?:\.\d+)?/);
  if (numericOnlyMatch) {
    return clampDurationMinutes(Number(numericOnlyMatch[0]));
  }

  return null;
};

const normalizeEstimatedDurationMinutes = (rawValue, fallbackMinutes = 60) => {
  const fromNumber = clampDurationMinutes(rawValue);
  if (fromNumber) return fromNumber;

  if (typeof rawValue === "string") {
    const fromText = parseDurationStringToMinutes(rawValue);
    if (fromText) return fromText;
  }

  return clampDurationMinutes(fallbackMinutes) || 60;
};

const computeFallbackEstimatedDurationMinutes = (task = {}) => {
  const complexity = Math.max(1, Math.min(5, Number(task.complexity) || 3));
  const descriptionLength = String(task.taskDescription || "").trim().length;
  const descriptionBoost = Math.min(40, Math.round(descriptionLength / 30) * 5);

  const categoryBoostMap = {
    development: 35,
    engineering: 35,
    analytics: 25,
    research: 25,
    design: 20,
    documentation: 10,
    reporting: 10,
    meeting: 5,
    support: 15,
  };

  const normalizedCategory = String(task.category || "").toLowerCase();
  const categoryBoost = categoryBoostMap[normalizedCategory] || 15;

  const baseMinutes = 30 + complexity * 15 + categoryBoost + descriptionBoost;
  return normalizeEstimatedDurationMinutes(baseMinutes, 60);
};

const extractEstimatedDurationCandidate = (payload = {}) => {
  if (!payload || typeof payload !== "object") return null;
  return (
    payload.estimated_duration_minutes ??
    payload.estimatedDurationMinutes ??
    payload.estimated_time ??
    payload.estimatedTime ??
    null
  );
};

const normalizePriorityValue = (value) => {
  const normalized = String(value || "").trim();
  return ["High", "Medium", "Low"].includes(normalized) ? normalized : "Medium";
};

const enrichTaskAiMetadataInBackground = async ({
  employeeEmail,
  task,
  hasManualEstimate,
  ioInstance,
}) => {
  if (!employeeEmail || !task?._id) return;

  const fallbackEstimatedMinutes =
    computeFallbackEstimatedDurationMinutes(task);
  let aiPriority = normalizePriorityValue(task.aiPriority);
  let aiPriorityReason =
    task.aiPriorityReason ||
    "Fallback priority applied while AI processing is unavailable.";
  let estimatedDuration = hasManualEstimate
    ? normalizeEstimatedDurationMinutes(
        task.estimatedDuration,
        fallbackEstimatedMinutes,
      )
    : fallbackEstimatedMinutes;

  try {
    const prompt = buildPriorityPrompt({
      title: task.taskTitle || "",
      description: task.taskDescription || "",
      metadata: {
        category: task.category || "",
        estimatedDuration: hasManualEstimate ? task.estimatedDuration : null,
        complexity: task.complexity,
      },
    });

    const raw = await callGemini(prompt, {
      maxRetries: 1,
      baseDelayMs: 2000,
      context: "task-priority-and-estimate-background",
      lockKey: `task-priority-and-estimate-background:${employeeEmail}:${String(task._id)}`,
    });

    const parsed = safeParseJson(raw, {});
    aiPriority = normalizePriorityValue(parsed?.priority);
    aiPriorityReason =
      String(parsed?.reason || "").trim() ||
      `AI marked this task as ${aiPriority} priority based on urgency and complexity.`;

    if (!hasManualEstimate) {
      const extractedDuration = extractEstimatedDurationCandidate(parsed);
      estimatedDuration = normalizeEstimatedDurationMinutes(
        extractedDuration,
        fallbackEstimatedMinutes,
      );
    }
  } catch (err) {
    recordAiFallback("server.task-create-priority-and-estimate");
    aiPriority = aiPriority || "Medium";
    aiPriorityReason =
      "AI temporarily unavailable. Applied fallback priority and estimated duration.";
    if (!hasManualEstimate) {
      estimatedDuration = fallbackEstimatedMinutes;
    }
  }

  const updateFields = {
    "tasks.$.aiPriority": aiPriority,
    "tasks.$.aiPriorityReason": aiPriorityReason,
    "tasks.$.aiEstimationPending": false,
  };

  if (!hasManualEstimate) {
    updateFields["tasks.$.estimatedDuration"] = estimatedDuration;
  }

  const updatedEmployee = await Employee.findOneAndUpdate(
    { email: employeeEmail, "tasks._id": task._id },
    { $set: updateFields },
    { new: true },
  );

  if (ioInstance && updatedEmployee) {
    ioInstance.emit("taskAiUpdated", {
      employeeEmail,
      taskId: task._id,
      aiPriority,
      estimatedDuration: hasManualEstimate
        ? task.estimatedDuration
        : estimatedDuration,
      updatedEmployee,
    });
    ioInstance.emit("employeeUpdated", {
      email: employeeEmail,
      employee: updatedEmployee,
    });
  }
};

const applyTaskTimeouts = (employeeOrUpdate) => {
  if (!employeeOrUpdate?.tasks || !Array.isArray(employeeOrUpdate.tasks)) {
    return false;
  }

  let changed = false;
  const now = new Date();
  const nowMs = now.getTime();

  employeeOrUpdate.tasks = employeeOrUpdate.tasks.map((task) => {
    const nextTask = { ...task };
    nextTask.estimatedDuration = Number(nextTask.estimatedDuration) || 0;
    nextTask.acceptanceTimeLimitMinutes =
      Number(nextTask.acceptanceTimeLimitMinutes) || 0;

    if (
      nextTask.newTask &&
      !nextTask.acceptedAt &&
      !nextTask.notAccepted &&
      nextTask.acceptanceTimeLimitMinutes > 0 &&
      nextTask.assignedAt &&
      isValidDate(nextTask.assignedAt)
    ) {
      if (!nextTask.acceptanceDeadline) {
        nextTask.acceptanceDeadline = new Date(
          new Date(nextTask.assignedAt).getTime() +
            nextTask.acceptanceTimeLimitMinutes * 60 * 1000,
        );
        changed = true;
      }
    }

    const acceptanceDeadlineMs =
      nextTask.acceptanceDeadline && isValidDate(nextTask.acceptanceDeadline)
        ? new Date(nextTask.acceptanceDeadline).getTime()
        : toTaskDeadline(nextTask.taskDate)?.getTime() || null;

    if (
      nextTask.newTask &&
      !nextTask.acceptedAt &&
      !nextTask.notAccepted &&
      acceptanceDeadlineMs &&
      nowMs > acceptanceDeadlineMs
    ) {
      nextTask.notAccepted = true;
      nextTask.newTask = false;
      nextTask.active = false;
      nextTask.completed = false;
      nextTask.failed = false;
      changed = true;
    }

    const startSource =
      nextTask.startedAt || nextTask.acceptedAt || nextTask.assignedAt;
    const startMs =
      startSource && isValidDate(startSource)
        ? new Date(startSource).getTime()
        : null;
    const completionDeadlineMs =
      startMs && nextTask.estimatedDuration > 0
        ? startMs + nextTask.estimatedDuration * 60 * 1000
        : null;

    if (
      nextTask.active &&
      !nextTask.completed &&
      !nextTask.failed &&
      completionDeadlineMs &&
      nowMs > completionDeadlineMs
    ) {
      nextTask.active = false;
      nextTask.completed = false;
      nextTask.failed = true;
      nextTask.completedAt = nextTask.completedAt || now;
      nextTask.onTime = false;
      changed = true;
    }

    return nextTask;
  });

  if (changed) {
    employeeOrUpdate.taskCounts = computeTaskCounts(employeeOrUpdate.tasks);
  }

  return changed;
};

const normalizeExplainPayload = (parsed, fallback) => {
  const summary = String(parsed?.summary || "").trim();
  const steps = Array.isArray(parsed?.steps)
    ? parsed.steps.map((step) => String(step || "").trim()).filter(Boolean)
    : [];
  const estimated_time = String(parsed?.estimated_time || "").trim();

  if (!summary && steps.length === 0) {
    return fallback;
  }

  return {
    summary: summary || fallback.summary,
    steps: steps.length > 0 ? steps : fallback.steps,
    estimated_time: estimated_time || fallback.estimated_time,
  };
};

const generateAndCacheTaskGuidance = async ({
  employeeEmail,
  task,
  ioInstance,
}) => {
  if (!employeeEmail || !task?._id) return;
  if (task.explainSummary) return;

  const fallback = buildRuleBasedTaskGuidance({
    title: task.taskTitle,
    description: task.taskDescription,
    metadata: {
      category: task.category,
      estimatedDuration: task.estimatedDuration,
      complexity: task.complexity,
    },
  });

  const prompt = buildExplainTaskPrompt({
    title: task.taskTitle,
    description: task.taskDescription,
    metadata: {
      category: task.category,
      complexity: task.complexity,
      estimatedDuration: task.estimatedDuration,
    },
  });

  let explanation = fallback;

  try {
    const raw = await callGemini(prompt, {
      maxRetries: 1,
      baseDelayMs: 2000,
      context: "task-create-background-guidance",
      lockKey: `task-create-background-guidance:${employeeEmail}:${task._id}`,
    });
    const parsed = safeParseJson(raw, fallback);
    explanation = normalizeExplainPayload(parsed, fallback);
  } catch {
    recordAiFallback("server.task-create-background-guidance");
    explanation = fallback;
  }

  const updatedEmployee = await Employee.findOneAndUpdate(
    { email: employeeEmail, "tasks._id": task._id },
    {
      $set: {
        "tasks.$.explainSummary": explanation.summary,
        "tasks.$.explainSteps": explanation.steps || [],
        "tasks.$.explainEstimatedTime": explanation.estimated_time,
      },
    },
    { new: true },
  );

  if (ioInstance && updatedEmployee) {
    ioInstance.emit("taskExplanationGenerated", {
      employeeEmail,
      taskId: task._id,
      explanation,
      updatedEmployee,
    });
    ioInstance.emit("employeeUpdated", {
      email: employeeEmail,
      employee: updatedEmployee,
    });
  }
};

// MongoDB connection
const connectDB = async () => {
  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  if (dbConnectPromise) {
    return dbConnectPromise;
  }

  const mongoUri =
    process.env.MONGODB_URI || "mongodb://localhost:27017/jobportal";
  const connectStart = Date.now();
  const usingEnvMongoUri = Boolean(process.env.MONGODB_URI);

  console.log("[db] connect start", {
    usingEnvMongoUri,
    readyState: mongoose.connection.readyState,
    uri: redactMongoUri(mongoUri),
  });

  dbConnectPromise = mongoose
    .connect(mongoUri, {
      serverSelectionTimeoutMS: Number(
        process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS || 12000,
      ),
      connectTimeoutMS: Number(process.env.MONGO_CONNECT_TIMEOUT_MS || 12000),
      socketTimeoutMS: Number(process.env.MONGO_SOCKET_TIMEOUT_MS || 15000),
      maxPoolSize: Number(process.env.MONGO_MAX_POOL_SIZE || 5),
    })
    .then((connection) => {
      lastDbConnectError = null;
      lastDbConnectAt = new Date().toISOString();
      console.log("MongoDB connected successfully");
      console.log("[db] connect success", {
        ms: Date.now() - connectStart,
        readyState: mongoose.connection.readyState,
      });
      return connection;
    })
    .catch((err) => {
      dbConnectPromise = null;
      lastDbConnectError = {
        at: new Date().toISOString(),
        ...serializeError(err),
      };
      console.error("MongoDB connection error:", err.message);
      console.error("[db] connect failure", {
        ms: Date.now() - connectStart,
        usingEnvMongoUri,
        readyState: mongoose.connection.readyState,
        error: serializeError(err),
      });
      throw err;
    });

  return dbConnectPromise;
};

// HTTP + Socket.io server (only for traditional Node server runtime)
let server = null;
let io = null;

if (!process.env.VERCEL) {
  server = http.createServer(app);
  io = new SocketIOServer(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST", "PUT"],
    },
  });

  io.on("connection", (socket) => {
    // Basic connection log; can be extended for rooms / auth later
    console.log("Client connected:", socket.id);

    socket.on("disconnect", () => {
      console.log("Client disconnected:", socket.id);
    });
  });
}

app.set("io", io);

// Middleware
app.use(cors());
app.use(bodyParser.json());

app.use((req, res, next) => {
  if (!req.path.startsWith("/api")) {
    return next();
  }

  const startedAt = Date.now();
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  req.requestId = requestId;

  res.on("finish", () => {
    const durationMs = Date.now() - startedAt;
    if (
      res.statusCode >= 500 ||
      req.path.includes("/auth/login") ||
      req.path === "/api/employees"
    ) {
      console.log("[api] response", {
        requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs,
      });
    }
  });

  next();
});

// Serve static files from the frontend build (if you build client separately)
app.use(express.static(path.join(process.cwd(), "backend", "dist")));

// API Endpoints

app.get("/api/health", async (req, res) => {
  const dbState = mongoose.connection.readyState;
  return res.json({
    ok: true,
    dbConnected: dbState === 1,
    dbState,
    vercel: Boolean(process.env.VERCEL),
    env: {
      hasMongoUri: Boolean(process.env.MONGODB_URI),
      hasGroqKey: Boolean(process.env.GROQ_API_KEY),
      nodeEnv: process.env.NODE_ENV || "unknown",
    },
    db: {
      lastDbConnectAt,
      lastDbConnectError,
    },
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/health/db", async (req, res) => {
  const startedAt = Date.now();

  try {
    await connectDB();
    return res.json({
      ok: true,
      dbConnected: mongoose.connection.readyState === 1,
      dbState: mongoose.connection.readyState,
      durationMs: Date.now() - startedAt,
      env: {
        hasMongoUri: Boolean(process.env.MONGODB_URI),
        hasGroqKey: Boolean(process.env.GROQ_API_KEY),
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return res.status(503).json({
      ok: false,
      dbConnected: false,
      dbState: mongoose.connection.readyState,
      durationMs: Date.now() - startedAt,
      env: {
        hasMongoUri: Boolean(process.env.MONGODB_URI),
        hasGroqKey: Boolean(process.env.GROQ_API_KEY),
      },
      error: {
        name: error?.name || "Error",
        code: error?.code || null,
        message: error?.message || "Unknown DB connection error",
      },
      hint: "If hasMongoUri=true and this fails, check MongoDB Atlas network access, user credentials, and region latency.",
      timestamp: new Date().toISOString(),
    });
  }
});

// Create a new employee (admin flow)
app.post("/api/employees", async (req, res) => {
  try {
    const { firstName, lastName, email, role } = req.body || {};

    if (!firstName || !email) {
      return res.status(400).json({
        error: "First name and email are required",
      });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const existing = await Employee.findOne({ email: normalizedEmail });
    if (existing) {
      return res.status(409).json({
        error: "Employee with this email already exists",
      });
    }

    const employee = await Employee.create({
      firstName: String(firstName).trim(),
      lastName: lastName ? String(lastName).trim() : "",
      email: normalizedEmail,
      role: role ? String(role).trim().toLowerCase() : "employee",
      password: "",
      isFirstLogin: true,
      isPasswordSet: false,
      isActivated: false,
      taskCounts: {
        active: 0,
        newTask: 0,
        completed: 0,
        failed: 0,
      },
      tasks: [],
    });

    const ioInstance = req.app.get("io");
    ioInstance?.emit("employeeUpdated", {
      email: employee.email,
      employee,
    });

    return res.status(201).json({
      success: true,
      employee,
    });
  } catch (err) {
    console.error("Create employee error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// Unified login endpoint (admin + employee with first-time flow)
app.post("/api/auth/login", async (req, res) => {
  try {
    await connectDB();
    const email = String(req.body?.email || "")
      .trim()
      .toLowerCase();
    const password = String(req.body?.password || "").trim();

    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    const admin = await Admin.findOne({ email, password }).lean();
    if (admin) {
      return res.json({ success: true, role: "admin" });
    }

    const employee = await Employee.findOne({ email });
    if (!employee) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const inferredPasswordSet =
      typeof employee.isPasswordSet === "boolean"
        ? employee.isPasswordSet
        : Boolean(employee.password);

    if (typeof employee.isPasswordSet !== "boolean") {
      employee.isPasswordSet = inferredPasswordSet;
      employee.isFirstLogin = !inferredPasswordSet;
      employee.isActivated = inferredPasswordSet;
      await employee.save();
    }

    if (!inferredPasswordSet) {
      return res.status(403).json({
        requiresPasswordSetup: true,
        message:
          "Welcome! Please set your password to activate your account before continuing.",
        employee: {
          firstName: employee.firstName,
          email: employee.email,
        },
      });
    }

    if (employee.password !== password) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    return res.json({
      success: true,
      role: "employee",
      employee,
    });
  } catch (err) {
    console.error("Auth login error:", err);
    console.error("[api] auth/login failure", {
      requestId: req.requestId,
      email: String(req.body?.email || "")
        .trim()
        .toLowerCase(),
      error: serializeError(err),
      dbState: mongoose.connection.readyState,
      hasMongoUri: Boolean(process.env.MONGODB_URI),
    });
    return res.status(500).json({ error: "Server error" });
  }
});

// First-time password setup endpoint
app.post("/api/auth/set-password", async (req, res) => {
  try {
    const email = String(req.body?.email || "")
      .trim()
      .toLowerCase();
    const newPassword = String(req.body?.newPassword || "").trim();

    if (!email || !newPassword) {
      return res.status(400).json({
        error: "Email and new password are required",
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        error: "Password must be at least 6 characters",
      });
    }

    const employee = await Employee.findOne({ email });
    if (!employee) {
      return res.status(404).json({ error: "Not authenticated employee" });
    }

    if (employee.isPasswordSet) {
      return res.status(409).json({
        error: "Account already activated. Please sign in.",
      });
    }

    employee.password = newPassword;
    employee.isPasswordSet = true;
    employee.isFirstLogin = false;
    employee.isActivated = true;
    await employee.save();

    const ioInstance = req.app.get("io");
    ioInstance?.emit("employeeUpdated", {
      email: employee.email,
      employee,
    });

    return res.json({
      success: true,
      message: "Password set successfully. You can now log in.",
    });
  } catch (err) {
    console.error("Set password error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// Signup endpoint (allowed only for admin-created employee IDs)
app.post("/api/auth/signup", async (req, res) => {
  try {
    const email = String(req.body?.email || "")
      .trim()
      .toLowerCase();
    const newPassword = String(req.body?.newPassword || "").trim();

    if (!email || !newPassword) {
      return res.status(400).json({
        error: "Email and password are required",
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        error: "Password must be at least 6 characters",
      });
    }

    const employee = await Employee.findOne({ email });
    if (!employee) {
      return res.status(403).json({
        error: "Not authenticated employee",
      });
    }

    if (employee.isPasswordSet || Boolean(employee.password)) {
      return res.status(409).json({
        error: "Account already activated. Please sign in.",
      });
    }

    employee.password = newPassword;
    employee.isPasswordSet = true;
    employee.isFirstLogin = false;
    employee.isActivated = true;
    await employee.save();

    const ioInstance = req.app.get("io");
    ioInstance?.emit("employeeUpdated", {
      email: employee.email,
      employee,
    });

    return res.json({
      success: true,
      message: "Signup successful. You can now sign in.",
    });
  } catch (err) {
    console.error("Signup error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// Get all employees
app.get("/api/employees", async (req, res) => {
  try {
    const employees = await Employee.find();
    res.json(employees);
  } catch (err) {
    console.error(err);
    console.error("[api] employees failure", {
      requestId: req.requestId,
      error: serializeError(err),
      dbState: mongoose.connection.readyState,
      hasMongoUri: Boolean(process.env.MONGODB_URI),
    });
    res.status(500).json({ error: "Server error" });
  }
});

// Get single employee by email
app.get("/api/employees/:email", async (req, res) => {
  try {
    let emp = await Employee.findOne({ email: req.params.email });
    if (emp) {
      const updatedEmp = emp.toObject();
      const hadTimeoutUpdates = applyTaskTimeouts(updatedEmp);
      if (hadTimeoutUpdates) {
        emp = await Employee.findOneAndUpdate(
          { email: req.params.email },
          {
            $set: {
              tasks: updatedEmp.tasks,
              taskCounts: updatedEmp.taskCounts,
            },
          },
          { new: true },
        );
      }
      res.json(emp);
    } else {
      res.status(404).json({ error: "Employee not found" });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// Update employee
app.put("/api/employees/:email", async (req, res) => {
  try {
    const update = req.body;

    // Get existing employee to detect new tasks
    const existingEmp = await Employee.findOne({ email: req.params.email });
    const existingTaskCount = existingEmp?.tasks?.length || 0;
    const previousTaskByKey = new Map(
      (existingEmp?.tasks || []).map((task) => [
        buildTaskIdentityKey(task),
        task,
      ]),
    );
    let changedTaskContext = null;
    let hadOutcomeTransition = false;

    // Preserve sensitive onboarding/auth fields when client sends partial updates.
    if (typeof update.password === "undefined") {
      update.password = existingEmp?.password || "";
    }
    if (typeof update.isFirstLogin === "undefined") {
      update.isFirstLogin = existingEmp?.isFirstLogin ?? false;
    }
    if (typeof update.isPasswordSet === "undefined") {
      update.isPasswordSet = existingEmp?.isPasswordSet ?? true;
    }
    if (typeof update.isActivated === "undefined") {
      update.isActivated = existingEmp?.isActivated ?? true;
    }
    if (typeof update.role === "undefined") {
      update.role = existingEmp?.role || "employee";
    }
    if (typeof update.lastName === "undefined") {
      update.lastName = existingEmp?.lastName || "";
    }

    // If tasks are being updated, check for new tasks and add AI priority
    if (
      update.tasks &&
      Array.isArray(update.tasks) &&
      update.tasks.length > existingTaskCount
    ) {
      const now = new Date();
      const activeTasks = (existingEmp?.tasks || []).filter(
        (t) => t.active,
      ).length;

      // Process each task - detect new ones and add AI priority
      update.tasks = await Promise.all(
        update.tasks.map(async (task, index) => {
          const previousTask = previousTaskByKey.get(
            buildTaskIdentityKey(task),
          );
          task.estimatedDuration = Number(task.estimatedDuration) || 0;
          task.acceptanceTimeLimitMinutes =
            Number(task.acceptanceTimeLimitMinutes) || 0;

          // If this is a new task (no _id or aiPriority), compute AI priority
          if (
            index >= existingTaskCount &&
            !task.aiPriority &&
            task.taskTitle
          ) {
            let aiPriority = "Medium";
            let aiPriorityReason = "Analyzing task priority...";

            try {
              const prompt = buildPriorityPrompt({
                title: task.taskTitle || "",
                description: task.taskDescription || "",
                metadata: {
                  category: task.category || "",
                  estimatedDuration: task.estimatedDuration,
                  complexity: task.complexity,
                  activeTasks: activeTasks,
                },
              });

              console.log(
                `[AI Priority] Analyzing new task via PUT: "${task.taskTitle}"`,
              );
              const raw = await callGemini(prompt, {
                maxRetries: 1,
                baseDelayMs: 2000,
                context: "task-priority-put-update",
                lockKey: `task-priority-put-update:${req.params.email}:${String(task.taskTitle || "").toLowerCase()}`,
              });
              const parsed = safeParseJson(raw, {
                priority: "Medium",
                reason: "AI analysis unavailable.",
              });

              if (
                parsed.priority &&
                ["High", "Medium", "Low"].includes(parsed.priority)
              ) {
                aiPriority = parsed.priority;
                aiPriorityReason =
                  parsed.reason ||
                  `AI determined this is ${parsed.priority} priority based on context.`;
                console.log(
                  `[AI Priority] Result: ${aiPriority} - ${aiPriorityReason}`,
                );
              }
            } catch (err) {
              console.error("[AI Priority] Error in PUT:", err.message);
              recordAiFallback("server.priority-put-update");
              aiPriorityReason = `AI priority detection failed: ${err.message}. Using Medium priority.`;
            }

            task.aiPriority = aiPriority;
            task.aiPriorityReason = aiPriorityReason;
            task.assignedAt = task.assignedAt || now;
            task.notAccepted = false;
            if (
              task.acceptanceTimeLimitMinutes > 0 &&
              !task.acceptanceDeadline
            ) {
              task.acceptanceDeadline = new Date(
                new Date(task.assignedAt).getTime() +
                  task.acceptanceTimeLimitMinutes * 60 * 1000,
              );
            }
          }

          // Keep completion metadata authoritative and consistent on every update.
          if (task.completed) {
            const completedAt =
              task.completedAt && isValidDate(task.completedAt)
                ? new Date(task.completedAt)
                : now;
            task.completedAt = completedAt;
            task.completionTime = resolveCompletionTimeMinutes(
              task,
              completedAt,
            );
            task.onTime = computeOnTime(completedAt, task.taskDate);
          }
          if (task.failed) {
            const completedAt =
              task.completedAt && isValidDate(task.completedAt)
                ? new Date(task.completedAt)
                : now;
            task.completedAt = completedAt;
            const computedOnTime = computeOnTime(completedAt, task.taskDate);
            task.onTime = computedOnTime === null ? null : false;
          }

          const prevCompleted = Boolean(previousTask?.completed);
          const prevFailed = Boolean(previousTask?.failed);
          const nowCompleted = Boolean(task.completed);
          const nowFailed = Boolean(task.failed);
          const transitionedToOutcome =
            (!prevCompleted && nowCompleted) || (!prevFailed && nowFailed);

          if (transitionedToOutcome) {
            hadOutcomeTransition = true;
            changedTaskContext = {
              taskTitle: task.taskTitle,
              taskDescription: task.taskDescription,
              taskStatus: nowCompleted ? "completed" : "failed",
              completedAt: task.completedAt,
            };
          }

          return task;
        }),
      );
    } else if (update.tasks && Array.isArray(update.tasks)) {
      // Just update timestamps for existing tasks
      const now = new Date();
      update.tasks = update.tasks.map((task) => {
        const previousTask = previousTaskByKey.get(buildTaskIdentityKey(task));
        task.estimatedDuration = Number(task.estimatedDuration) || 0;
        task.acceptanceTimeLimitMinutes =
          Number(task.acceptanceTimeLimitMinutes) || 0;

        if (task.completed) {
          const completedAt =
            task.completedAt && isValidDate(task.completedAt)
              ? new Date(task.completedAt)
              : now;
          task.completedAt = completedAt;
          task.completionTime = resolveCompletionTimeMinutes(task, completedAt);
          task.onTime = computeOnTime(completedAt, task.taskDate);
        }
        if (task.failed) {
          const completedAt =
            task.completedAt && isValidDate(task.completedAt)
              ? new Date(task.completedAt)
              : now;
          task.completedAt = completedAt;
          const computedOnTime = computeOnTime(completedAt, task.taskDate);
          task.onTime = computedOnTime === null ? null : false;
        }

        const prevCompleted = Boolean(previousTask?.completed);
        const prevFailed = Boolean(previousTask?.failed);
        const nowCompleted = Boolean(task.completed);
        const nowFailed = Boolean(task.failed);
        const transitionedToOutcome =
          (!prevCompleted && nowCompleted) || (!prevFailed && nowFailed);

        if (transitionedToOutcome) {
          hadOutcomeTransition = true;
          changedTaskContext = {
            taskTitle: task.taskTitle,
            taskDescription: task.taskDescription,
            taskStatus: nowCompleted ? "completed" : "failed",
            completedAt: task.completedAt,
          };
        }
        return task;
      });
    }

    if (hadOutcomeTransition) {
      // Force next insights request to recompute using fresh post-completion data.
      update.lastInsightUpdate = null;
      update.storedInsights = [];
    }

    applyTaskTimeouts(update);

    const emp = await Employee.findOneAndUpdate(
      { email: req.params.email },
      update,
      { new: true },
    );
    if (emp) {
      // Emit realtime update for graphs and insights refresh
      const ioInstance = req.app.get("io");
      ioInstance?.emit("employeeUpdated", {
        email: emp.email,
        employee: emp,
      });
      // Also emit task status change event for immediate graph updates
      ioInstance?.emit("taskStatusChanged", {
        email: emp.email,
        employee: emp,
      });

      // If a task was just completed/failed, trigger insight regeneration with context
      if (changedTaskContext) {
        ioInstance?.emit("taskActionCompleted", {
          email: emp.email,
          employeeId: emp._id,
          action: changedTaskContext.taskStatus,
          taskTitle: changedTaskContext.taskTitle,
          taskDescription: changedTaskContext.taskDescription,
          taskStatus: changedTaskContext.taskStatus,
          completedAt: changedTaskContext.completedAt,
        });
      }

      res.json(emp);
    } else {
      res.status(404).json({ error: "Employee not found" });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// Add new task to employee
app.post("/api/employees/:email/tasks", async (req, res) => {
  try {
    const emp = await Employee.findOne({ email: req.params.email });
    if (emp) {
      const ioInstance = req.app.get("io");
      const now = new Date();
      const requestedEstimatedDuration = Number(req.body.estimatedDuration);
      const hasManualEstimate =
        Number.isFinite(requestedEstimatedDuration) &&
        requestedEstimatedDuration > 0;
      const rawTask = {
        ...req.body,
        estimatedDuration: hasManualEstimate
          ? normalizeEstimatedDurationMinutes(requestedEstimatedDuration, 60)
          : 0,
        acceptanceTimeLimitMinutes:
          Number(req.body.acceptanceTimeLimitMinutes) || 0,
        aiEstimationPending: !hasManualEstimate,
        assignedAt: req.body.assignedAt || now,
        createdAt: now,
      };

      if (rawTask.acceptanceTimeLimitMinutes > 0) {
        rawTask.acceptanceDeadline = new Date(
          new Date(rawTask.assignedAt).getTime() +
            rawTask.acceptanceTimeLimitMinutes * 60 * 1000,
        );
      }
      rawTask.notAccepted = false;

      const taskToSave = {
        ...rawTask,
        aiPriority: "Medium",
        aiPriorityReason: "Analyzing task priority and duration...",
      };

      emp.tasks.push(taskToSave);
      emp.taskCounts = emp.taskCounts || {
        active: 0,
        newTask: 0,
        completed: 0,
        failed: 0,
      };
      emp.taskCounts.newTask += 1;

      await emp.save();

      // Emit realtime update for this employee + new task
      ioInstance?.emit("taskCreated", {
        email: emp.email,
        task: emp.tasks[emp.tasks.length - 1],
      });

      res.status(201).json(emp);

      const createdTask = emp.tasks[emp.tasks.length - 1];
      enrichTaskAiMetadataInBackground({
        employeeEmail: emp.email,
        task: createdTask,
        hasManualEstimate,
        ioInstance,
      }).catch((err) => {
        console.warn(
          "Background task priority/estimate enrichment failed:",
          err.message,
        );
      });

      // Intentionally avoid automatic explain-task generation here.
      // AI guidance/checklist is fetched only when an accepted-task user requests AI Insights.
    } else {
      res.status(404).json({ error: "Employee not found" });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// Gemini / AI endpoints
app.use("/api/gemini", geminiRouter);

// Productivity analytics endpoints
app.use("/api/productivity", productivityRouter);

// Admin login
app.post("/api/admin/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const found = await Admin.findOne({ email, password });
    if (found) {
      res.json({ success: true });
    } else {
      res.status(401).json({ error: "Invalid credentials" });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// Start server
const startServer = async () => {
  await connectDB();
  if (!server) {
    throw new Error(
      "HTTP server is not initialized in this runtime. Use /api handler on Vercel.",
    );
  }
  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
};

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  startServer().catch((err) => {
    console.error("Failed to start server:", err);
    process.exit(1);
  });
}

export { app, connectDB, startServer };
export default app;
