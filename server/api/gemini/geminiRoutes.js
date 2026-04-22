import express from "express";
import { Employee } from "../../models.js";
import {
  callGemini,
  safeParseJson,
  getRetryAfterMs,
  isGeminiRateLimited,
  getAiTelemetrySnapshot,
  recordAiFallback,
} from "./geminiClient.js";
import {
  buildPriorityPrompt,
  buildExplainTaskPrompt,
  buildRuleBasedTaskGuidance,
} from "./geminiPrompts.js";

const router = express.Router();

const explainInFlight = new Map();
const explainCooldownUntil = new Map();

const getTaskLookupKey = ({ employeeEmail, taskId, taskLookup, title }) =>
  [
    employeeEmail || "unknown",
    taskId || "",
    taskLookup?.taskTitle || title || "",
    taskLookup?.taskDate || "",
  ].join("::");

const getExistingTaskExplanation = (task) => {
  if (!task?.explainSummary) return null;
  return {
    summary: task.explainSummary,
    steps: Array.isArray(task.explainSteps) ? task.explainSteps : [],
    estimated_time: task.explainEstimatedTime || "N/A",
    fromCache: true,
  };
};

const normalizeExplanationPayload = (payload, fallbackPayload) => {
  const summary = String(payload?.summary || "").trim();
  const steps = Array.isArray(payload?.steps)
    ? payload.steps.map((step) => String(step || "").trim()).filter(Boolean)
    : [];
  const estimated_time = String(payload?.estimated_time || "").trim();

  if (!summary && steps.length === 0) {
    return fallbackPayload;
  }

  return {
    summary: summary || fallbackPayload.summary,
    steps: steps.length > 0 ? steps : fallbackPayload.steps,
    estimated_time: estimated_time || fallbackPayload.estimated_time,
    fromFallback: Boolean(payload?.fromFallback),
  };
};

const parseEstimatedMinutes = (value) => {
  const text = String(value || "")
    .toLowerCase()
    .trim();
  if (!text) return 0;

  const rangeMatch = text.match(
    /(\d+(?:\.\d+)?)\s*(?:-|to|–)\s*(\d+(?:\.\d+)?)/,
  );
  if (rangeMatch) {
    const first = Number(rangeMatch[1]);
    const second = Number(rangeMatch[2]);
    if (!Number.isNaN(first) && !Number.isNaN(second)) {
      const avg = (first + second) / 2;
      const isHours = /(hour|hours|hr|hrs)\b/.test(text);
      return Math.max(1, Math.min(480, Math.round(isHours ? avg * 60 : avg)));
    }
  }

  const minutesMatch = text.match(
    /(\d+(?:\.\d+)?)\s*(?:m|min|mins|minute|minutes)\b/,
  );
  if (minutesMatch) {
    const num = Number(minutesMatch[1]);
    return Number.isNaN(num) ? 0 : Math.max(1, Math.min(480, Math.round(num)));
  }

  const hoursMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)\b/);
  if (hoursMatch) {
    const num = Number(hoursMatch[1]);
    return Number.isNaN(num)
      ? 0
      : Math.max(1, Math.min(480, Math.round(num * 60)));
  }

  const numericOnly = text.match(/\d+(?:\.\d+)?/);
  if (numericOnly) {
    const num = Number(numericOnly[0]);
    return Number.isNaN(num) ? 0 : Math.max(1, Math.min(480, Math.round(num)));
  }

  return 0;
};

const persistTaskExplanation = async ({
  employeeEmail,
  taskId,
  taskLookup,
  explanation,
}) => {
  if (!employeeEmail) return null;

  let updatedEmployee = null;

  if (taskId) {
    updatedEmployee = await Employee.findOneAndUpdate(
      { email: employeeEmail, "tasks._id": taskId },
      {
        $set: {
          "tasks.$.explainSummary": explanation.summary,
          "tasks.$.explainSteps": explanation.steps || [],
          "tasks.$.explainEstimatedTime": explanation.estimated_time,
        },
      },
      { new: true },
    );
  }

  if (!updatedEmployee && taskLookup) {
    updatedEmployee = await Employee.findOneAndUpdate(
      {
        email: employeeEmail,
        tasks: {
          $elemMatch: {
            taskTitle: taskLookup.taskTitle,
            taskDate: taskLookup.taskDate,
            taskDescription: taskLookup.taskDescription,
          },
        },
      },
      {
        $set: {
          "tasks.$.explainSummary": explanation.summary,
          "tasks.$.explainSteps": explanation.steps || [],
          "tasks.$.explainEstimatedTime": explanation.estimated_time,
        },
      },
      { new: true },
    );
  }

  const suggestedMinutes = parseEstimatedMinutes(explanation?.estimated_time);
  if (updatedEmployee && suggestedMinutes > 0) {
    const targetTask = taskId
      ? updatedEmployee.tasks.id(taskId)
      : updatedEmployee.tasks.find(
          (candidate) =>
            candidate.taskTitle === taskLookup?.taskTitle &&
            candidate.taskDate === taskLookup?.taskDate &&
            candidate.taskDescription === taskLookup?.taskDescription,
        );

    const currentEstimated = Number(targetTask?.estimatedDuration);
    if (!currentEstimated || currentEstimated <= 0) {
      updatedEmployee = await Employee.findOneAndUpdate(
        { email: employeeEmail, "tasks._id": targetTask?._id },
        {
          $set: {
            "tasks.$.estimatedDuration": suggestedMinutes,
            "tasks.$.aiEstimationPending": false,
          },
        },
        { new: true },
      );
    }
  }

  return updatedEmployee;
};

router.get("/monitoring", (req, res) => {
  return res.json({
    aiTelemetry: getAiTelemetrySnapshot(),
  });
});

// POST /api/gemini/priority
router.post("/priority", async (req, res) => {
  try {
    const { title, description, metadata } = req.body || {};
    console.log("[Gemini][priority] Incoming payload:", {
      hasTitle: !!title,
      hasDescription: !!description,
      metadata,
    });
    if (!description && !title) {
      return res
        .status(400)
        .json({ error: "Task title or description is required" });
    }

    const prompt = buildPriorityPrompt({ title, description, metadata });
    const raw = await callGemini(prompt, {
      context: "priority-task-analysis",
      maxRetries: 1,
      baseDelayMs: 2000,
      lockKey: "priority-task-analysis",
    });
    const parsed = safeParseJson(raw, {
      priority: "Medium",
      reason: "Fallback: could not parse Gemini response.",
    });

    return res.json({
      priority: parsed.priority || "Medium",
      reason: parsed.reason || "No reason provided",
      raw,
    });
  } catch (err) {
    console.error("[Gemini][priority] Error:", {
      message: err?.message,
      status: err?.response?.status,
      data: err?.response?.data,
    });
    recordAiFallback("geminiRoutes.priority-call-failed");
    return res.json({
      priority: "Medium",
      reason:
        "AI priority is temporarily unavailable. Using safe default priority based on system rules.",
      fromFallback: true,
    });
  }
});

// POST /api/gemini/explain-task
router.post("/explain-task", async (req, res) => {
  try {
    const { employeeEmail, taskId, taskLookup, title, description, metadata } =
      req.body;

    console.log("[Gemini][explain-task] Incoming payload:", {
      employeeEmail,
      taskId,
      hasTitle: !!title,
      hasDescription: !!description,
      metadata,
    });

    if (!description && !title) {
      return res
        .status(400)
        .json({ error: "Task title or description is required" });
    }

    const explainKey = getTaskLookupKey({
      employeeEmail,
      taskId,
      taskLookup,
      title,
    });

    const fallbackExplanation = buildRuleBasedTaskGuidance({
      title,
      description,
      metadata,
    });

    if (employeeEmail) {
      const employee = await Employee.findOne({ email: employeeEmail });
      if (employee) {
        let task = null;
        if (taskId) {
          try {
            task = employee.tasks.id(taskId);
          } catch {
            task = null;
          }
        }
        if (!task && taskLookup) {
          task = employee.tasks.find(
            (candidate) =>
              candidate.taskTitle === taskLookup.taskTitle &&
              candidate.taskDate === taskLookup.taskDate &&
              candidate.taskDescription === taskLookup.taskDescription,
          );
        }
        const existing = getExistingTaskExplanation(task);
        if (existing) {
          return res.json(existing);
        }
      }
    }

    const cooldownUntil = explainCooldownUntil.get(explainKey) || 0;
    if (Date.now() < cooldownUntil) {
      recordAiFallback("geminiRoutes.explain-task-cooldown");
      return res.json({
        ...fallbackExplanation,
        fromFallback: true,
      });
    }

    if (explainInFlight.has(explainKey)) {
      const inFlightResult = await explainInFlight.get(explainKey);
      return res.json(inFlightResult);
    }

    const prompt = buildExplainTaskPrompt({ title, description, metadata });
    const explainPromise = (async () => {
      let raw = "";
      let parsed = fallbackExplanation;
      let usedFallback = false;

      try {
        raw = await callGemini(prompt, {
          maxRetries: 1,
          baseDelayMs: 2000,
          context: "task-explain-explicit-request",
          lockKey: explainKey,
        });
        parsed = normalizeExplanationPayload(
          safeParseJson(raw, fallbackExplanation),
          fallbackExplanation,
        );
        usedFallback = Boolean(parsed.fromFallback);
      } catch (err) {
        if (isGeminiRateLimited(err)) {
          const retryAfterMs = getRetryAfterMs(err);
          explainCooldownUntil.set(explainKey, Date.now() + retryAfterMs);
        }
        parsed = fallbackExplanation;
        usedFallback = true;
        recordAiFallback("geminiRoutes.explain-task-call-failed");
      }

      const responsePayload = {
        summary: parsed.summary,
        steps: parsed.steps || [],
        estimated_time: parsed.estimated_time,
        fromFallback: usedFallback,
        raw,
      };

      if (employeeEmail) {
        try {
          const updatedEmployee = await persistTaskExplanation({
            employeeEmail,
            taskId,
            taskLookup,
            explanation: parsed,
          });

          const ioInstance = req.app.get("io");
          if (ioInstance && updatedEmployee) {
            ioInstance.emit("taskExplanationGenerated", {
              employeeEmail,
              taskId,
              explanation: parsed,
              updatedEmployee,
            });
            ioInstance.emit("employeeUpdated", {
              email: employeeEmail,
              employee: updatedEmployee,
            });
          }
        } catch (persistErr) {
          console.warn(
            "Failed to persist explain-task output:",
            persistErr.message,
          );
        }
      }

      return responsePayload;
    })();

    explainInFlight.set(explainKey, explainPromise);

    try {
      const result = await explainPromise;
      return res.json(result);
    } finally {
      explainInFlight.delete(explainKey);
    }
  } catch (err) {
    const explainKey = getTaskLookupKey({
      employeeEmail: req.body?.employeeEmail,
      taskId: req.body?.taskId,
      taskLookup: req.body?.taskLookup,
      title: req.body?.title,
    });
    const fallbackExplanation = buildRuleBasedTaskGuidance({
      title: req.body?.title,
      description: req.body?.description,
      metadata: req.body?.metadata,
    });

    if (isGeminiRateLimited(err)) {
      const retryAfterMs = getRetryAfterMs(err);
      explainCooldownUntil.set(explainKey, Date.now() + retryAfterMs);
      recordAiFallback("geminiRoutes.explain-task-top-level-429");
      return res.json({
        ...fallbackExplanation,
        fromFallback: true,
      });
    }

    recordAiFallback("geminiRoutes.explain-task-top-level-error");
    return res.json({
      ...fallbackExplanation,
      fromFallback: true,
    });
  }
});

export default router;
