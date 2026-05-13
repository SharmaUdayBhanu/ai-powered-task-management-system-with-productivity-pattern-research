import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import mongoose from "mongoose";
import dotenv from "dotenv";
import http from "http";
import { Server as SocketIOServer } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcryptjs";

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

const isBcryptHash = (value = "") => /^\$2[aby]\$/.test(String(value));

const verifyPassword = async (stored, incoming) => {
  if (!stored) return false;
  if (isBcryptHash(stored)) {
    return bcrypt.compare(String(incoming || ""), stored);
  }
  return String(stored) === String(incoming || "");
};

const upgradePasswordIfNeeded = async (modelInstance, incomingPassword) => {
  if (!modelInstance?.password) return;
  if (isBcryptHash(modelInstance.password)) return;

  const hashed = await bcrypt.hash(String(incomingPassword || ""), 10);
  modelInstance.password = hashed;
  await modelInstance.save();
};

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

const addDaysToTaskDate = (taskDateValue, daysToAdd) => {
  const base = taskDateValue ? new Date(taskDateValue) : new Date();
  if (Number.isNaN(base.getTime())) return null;
  base.setDate(base.getDate() + daysToAdd);
  return base;
};

/** YYYY-MM-DD must be today or later (UTC calendar day). */
const isTaskDueDateInPast = (taskDateValue) => {
  const str = String(taskDateValue || "").trim();
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const picked = new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])),
  );
  if (Number.isNaN(picked.getTime())) return false;
  const now = new Date();
  const todayUtc = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  return picked.getTime() < todayUtc.getTime();
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

const normalizeStepChecks = (task = {}, steps = []) => {
  const existing = Array.isArray(task.explainStepChecks)
    ? task.explainStepChecks
    : [];
  if (!steps.length) return [];
  if (existing.length === steps.length) {
    return existing.map((value) => Boolean(value));
  }
  return steps.map((_, idx) => Boolean(existing[idx]));
};

const areSingleTaskStepsComplete = (task = {}) => {
  const steps = Array.isArray(task.explainSteps) ? task.explainSteps : [];
  if (steps.length === 0) return true;
  const checks = normalizeStepChecks(task, steps);
  return checks.length === steps.length && checks.every(Boolean);
};

const areGroupTaskStepsCompleteForEmployee = (task = {}, employeeEmail) => {
  const assignments = Array.isArray(task.groupStepAssignments)
    ? task.groupStepAssignments
    : [];
  if (assignments.length === 0) return true;
  const normalizedEmail = String(employeeEmail || "")
    .trim()
    .toLowerCase();
  const assigned = assignments.filter(
    (step) =>
      String(step.assignedEmail || "")
        .trim()
        .toLowerCase() === normalizedEmail,
  );
  if (assigned.length === 0) return true;
  return assigned.every((step) => Boolean(step.completed));
};

const canMarkTaskComplete = (task = {}, employeeEmail) => {
  if (task.groupTask && task.groupId) {
    return areGroupTaskStepsCompleteForEmployee(task, employeeEmail);
  }
  return areSingleTaskStepsComplete(task);
};

const isChatEnabledForTask = (task = {}) => {
  if (task.groupTask && task.groupId) return true;
  return Boolean(task.chatEnabled || task.active);
};

const isChatOpenForTask = (task = {}) => {
  if (!isChatEnabledForTask(task)) return false;
  if (task.chatClosed) return false;
  return Boolean(task.active && !task.newTask && !task.completed && !task.failed);
};

const buildChatMessage = ({
  senderName,
  senderEmail,
  senderRole,
  message,
  type = "user",
}) => ({
  messageId: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  senderName: String(senderName || "System").trim(),
  senderEmail: senderEmail ? String(senderEmail).trim() : undefined,
  senderRole: senderRole ? String(senderRole).trim() : undefined,
  message: String(message || "").trim(),
  createdAt: new Date(),
  type,
});

const appendChatMessageForTask = async ({
  employee,
  task,
  chatMessage,
  ioInstance,
}) => {
  if (!employee || !task || !chatMessage?.message) return null;
  if (!isChatOpenForTask(task)) return null;
  task.chatMessages = Array.isArray(task.chatMessages) ? task.chatMessages : [];
  task.chatMessages.push(chatMessage);
  await employee.save();
  ioInstance?.emit("taskChatMessage", {
    taskId: task._id,
    groupId: task.groupId,
    message: chatMessage,
  });
  ioInstance?.emit("employeeUpdated", {
    email: employee.email,
    employee,
  });
  return employee;
};

const appendChatMessageForGroup = async ({
  groupId,
  chatMessage,
  ioInstance,
}) => {
  if (!groupId || !chatMessage?.message) return [];
  const employees = await Employee.find({ "tasks.groupId": groupId });
  if (!employees.length) return [];

  const updated = [];
  for (const employee of employees) {
    const task = employee.tasks.find((item) => item.groupId === groupId);
    if (!task) continue;
    if (task.chatClosed) continue;
    task.chatMessages = Array.isArray(task.chatMessages)
      ? task.chatMessages
      : [];
    task.chatMessages.push(chatMessage);
    await employee.save();
    updated.push(employee);
  }

  ioInstance?.emit("taskChatMessage", {
    groupId,
    message: chatMessage,
  });
  updated.forEach((employee) =>
    ioInstance?.emit("employeeUpdated", {
      email: employee.email,
      employee,
    }),
  );

  return updated;
};

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

const inferEmployeeSpeciality = (employee = {}) => {
  const role = String(employee.role || "").toLowerCase();
  const taskText = (employee.tasks || [])
    .map(
      (task) =>
        `${task.category || ""} ${task.taskTitle || ""} ${task.taskDescription || ""}`,
    )
    .join(" ")
    .toLowerCase();
  const text = `${role} ${taskText}`;

  if (/design|ui|ux|figma|prototype|visual/.test(text)) return "Design";
  if (/data|analytics|report|metric|dashboard|insight/.test(text))
    return "Analytics";
  if (/manager|planning|coordination|stakeholder|review/.test(text))
    return "Coordination";
  if (/test|qa|bug|quality/.test(text)) return "Quality";
  if (/dev|code|api|frontend|backend|engineering|feature/.test(text))
    return "Development";
  return "Generalist";
};

const buildGroupMembers = (employees = []) =>
  employees.map((employee) => ({
    email: employee.email,
    name: [employee.firstName, employee.lastName].filter(Boolean).join(" "),
    role: employee.role || "employee",
    accepted: false,
  }));

const assignGroupSteps = ({ steps = [], members = [] }) => {
  if (!steps.length || !members.length) return [];
  return steps.map((step, idx) => {
    const lower = String(step || "").toLowerCase();
    const preferred =
      members.find((member) => {
        const profile = String(member.role || "").toLowerCase();
        return (
          (/design|wireframe|visual|ui|ux/.test(lower) &&
            /design|ui|ux|designer/.test(profile)) ||
          (/data|metric|report|analysis|dashboard/.test(lower) &&
            /analytic|data|analyst/.test(profile)) ||
          (/test|qa|verify|bug/.test(lower) &&
            /quality|qa|test/.test(profile)) ||
          (/plan|coordinate|review|stakeholder/.test(lower) &&
            /manager|coordination|lead|owner/.test(profile)) ||
          (/code|api|build|implement|develop/.test(lower) &&
            /dev|engineer|developer|development/.test(profile))
        );
      }) || members[idx % members.length];

    return {
      step,
      assignedEmail: preferred.email,
      assignedName: preferred.name || preferred.email,
      completed: false,
    };
  });
};

const syncGroupTaskFields = async ({ groupId, fields, ioInstance }) => {
  if (!groupId || !fields || typeof fields !== "object") return;
  const setFields = Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [`tasks.$.${key}`, value]),
  );
  const employees = await Employee.find({ "tasks.groupId": groupId });
  await Employee.updateMany({ "tasks.groupId": groupId }, { $set: setFields });
  employees.forEach((employee) => {
    ioInstance?.emit("employeeUpdated", {
      email: employee.email,
      employee,
    });
  });
};

const pickCanonicalGroupTask = (tasks = []) => {
  if (!tasks.length) return null;
  let best = tasks[0];
  let bestScore = -1;

  tasks.forEach((task) => {
    const assignmentCount = Array.isArray(task.groupStepAssignments)
      ? task.groupStepAssignments.length
      : 0;
    const stepsCount = Array.isArray(task.explainSteps)
      ? task.explainSteps.length
      : 0;
    const membersCount = Array.isArray(task.groupMembers)
      ? task.groupMembers.length
      : 0;
    const summaryScore = task.explainSummary ? 10 : 0;
    const score =
      assignmentCount * 100 + stepsCount * 10 + membersCount + summaryScore;

    if (score > bestScore) {
      bestScore = score;
      best = task;
    }
  });

  return best;
};

const buildGroupMembersFromEmployees = ({ employees = [], tasks = [] }) => {
  const memberMap = new Map();
  const acceptedAtMap = new Map();

  tasks.forEach((task) => {
    (task.groupMembers || []).forEach((member) => {
      const email = String(member?.email || "").toLowerCase();
      if (!email) return;
      if (!memberMap.has(email)) {
        memberMap.set(email, {
          email,
          name: member.name,
          role: member.role,
          accepted: Boolean(member.accepted),
          acceptedAt: member.acceptedAt,
        });
      }
      if (member.acceptedAt) {
        acceptedAtMap.set(email, member.acceptedAt);
      }
    });
  });

  employees.forEach((employee) => {
    const email = String(employee.email || "").toLowerCase();
    if (!email) return;
    const existing = memberMap.get(email) || {};
    memberMap.set(email, {
      email,
      name:
        existing.name ||
        [employee.firstName, employee.lastName].filter(Boolean).join(" ") ||
        employee.email,
      role: existing.role || employee.role || "employee",
      accepted: Boolean(existing.accepted),
      acceptedAt: existing.acceptedAt || acceptedAtMap.get(email) || null,
    });
  });

  return Array.from(memberMap.values());
};

const assignGroupStepsByRole = ({ steps = [], members = [] }) => {
  if (!steps.length || !members.length) return [];
  return steps.map((step, idx) => {
    const lower = String(step || "").toLowerCase();
    const preferred =
      members.find((member) => {
        const profile = String(member.role || "").toLowerCase();
        return (
          (/design|wireframe|visual|ui|ux/.test(lower) &&
            /design|ui|ux|designer/.test(profile)) ||
          (/data|metric|report|analysis|dashboard/.test(lower) &&
            /analytic|data|analyst/.test(profile)) ||
          (/test|qa|verify|bug/.test(lower) &&
            /quality|qa|test/.test(profile)) ||
          (/plan|coordinate|review|stakeholder/.test(lower) &&
            /manager|coordination|lead|owner/.test(profile)) ||
          (/code|api|build|implement|develop/.test(lower) &&
            /dev|engineer|developer|development/.test(profile))
        );
      }) || members[idx % members.length];

    return {
      step,
      assignedEmail: preferred.email,
      assignedName: preferred.name || preferred.email,
      completed: false,
    };
  });
};

const buildGroupMemberEstimates = ({ assignments = [], totalMinutes = 0 }) => {
  if (!assignments.length || totalMinutes <= 0) return [];
  const baseMinutes = Math.floor(totalMinutes / assignments.length);
  let remainder = totalMinutes % assignments.length;
  const totals = {};

  assignments.forEach((assignment) => {
    const allocation = baseMinutes + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder -= 1;
    if (!assignment.assignedEmail) return;
    totals[assignment.assignedEmail] =
      (totals[assignment.assignedEmail] || 0) + allocation;
  });

  return Object.entries(totals).map(([email, estimatedMinutes]) => ({
    email,
    estimatedMinutes,
  }));
};

const normalizeGroupTaskData = async ({ groupId, ioInstance }) => {
  if (!groupId) return false;
  const employees = await Employee.find({ "tasks.groupId": groupId });
  if (!employees.length) return false;

  const tasks = employees
    .map((employee) =>
      (employee.tasks || []).find((task) => task.groupId === groupId),
    )
    .filter(Boolean);

  if (!tasks.length) return false;

  const canonical = pickCanonicalGroupTask(tasks);
  const acceptedEmails = Array.from(
    new Set(
      tasks.flatMap((task) =>
        Array.isArray(task.groupAcceptedEmails) ? task.groupAcceptedEmails : [],
      ),
    ),
  );

  const members = buildGroupMembersFromEmployees({ employees, tasks }).map(
    (member) => ({
      ...member,
      accepted: acceptedEmails.includes(member.email),
    }),
  );

  let assignments = Array.isArray(canonical.groupStepAssignments)
    ? canonical.groupStepAssignments.map((item) => item.toObject?.() || item)
    : [];

  if (!assignments.length) {
    const fallbackTask = tasks.find(
      (task) =>
        Array.isArray(task.groupStepAssignments) &&
        task.groupStepAssignments.length > 0,
    );
    if (fallbackTask?.groupStepAssignments?.length) {
      assignments = fallbackTask.groupStepAssignments.map(
        (item) => item.toObject?.() || item,
      );
    }
  }

  const explainSteps = Array.isArray(canonical.explainSteps)
    ? canonical.explainSteps
    : [];

  if (!assignments.length && explainSteps.length > 0) {
    assignments = assignGroupStepsByRole({ steps: explainSteps, members });
  }

  const fields = {
    groupTask: true,
    groupMembers: members,
    groupAcceptedEmails: acceptedEmails,
  };

  if (assignments.length) fields.groupStepAssignments = assignments;
  if (canonical.explainSummary)
    fields.explainSummary = canonical.explainSummary;
  if (explainSteps.length) fields.explainSteps = explainSteps;
  if (canonical.explainEstimatedTime) {
    fields.explainEstimatedTime = canonical.explainEstimatedTime;
  }
  if (canonical.explainSource) fields.explainSource = canonical.explainSource;

  if (assignments.length) {
    const totalMinutes =
      Number(canonical.estimatedDuration) ||
      parseDurationStringToMinutes(canonical.explainEstimatedTime) ||
      0;
    const estimates = buildGroupMemberEstimates({
      assignments,
      totalMinutes,
    });
    if (estimates.length) fields.groupMemberEstimates = estimates;
  }

  await syncGroupTaskFields({ groupId, fields, ioInstance });
  return true;
};

const collectGroupIdsFromEmployees = (employees = []) => {
  const groupIds = new Set();
  employees.forEach((employee) => {
    (employee.tasks || []).forEach((task) => {
      if (task?.groupId) groupIds.add(task.groupId);
    });
  });
  return groupIds;
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

const enrichGroupTaskAiMetadataInBackground = async ({
  groupId,
  baseTask,
  hasManualEstimate,
  ioInstance,
}) => {
  if (!groupId || !baseTask) return;

  const fallbackEstimatedMinutes =
    computeFallbackEstimatedDurationMinutes(baseTask);
  let aiPriority = normalizePriorityValue(baseTask.aiPriority);
  let aiPriorityReason =
    baseTask.aiPriorityReason ||
    "Fallback priority applied while AI processing is unavailable.";
  let estimatedDuration = hasManualEstimate
    ? normalizeEstimatedDurationMinutes(
        baseTask.estimatedDuration,
        fallbackEstimatedMinutes,
      )
    : fallbackEstimatedMinutes;

  try {
    const prompt = buildPriorityPrompt({
      title: baseTask.taskTitle || "",
      description: baseTask.taskDescription || "",
      metadata: {
        category: baseTask.category || "",
        estimatedDuration: hasManualEstimate
          ? baseTask.estimatedDuration
          : null,
        complexity: baseTask.complexity,
      },
    });

    const raw = await callGemini(prompt, {
      maxRetries: 1,
      baseDelayMs: 2000,
      context: "group-task-priority-and-estimate-background",
      lockKey: `group-task-priority-and-estimate-background:${groupId}`,
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
    recordAiFallback("server.group-task-priority-and-estimate");
    aiPriority = aiPriority || "Medium";
    aiPriorityReason =
      "AI temporarily unavailable. Applied fallback priority and estimated duration.";
    if (!hasManualEstimate) {
      estimatedDuration = fallbackEstimatedMinutes;
    }
  }

  const fields = {
    aiPriority,
    aiPriorityReason,
    aiEstimationPending: false,
  };

  if (!hasManualEstimate) {
    fields.estimatedDuration = estimatedDuration;
  }

  await syncGroupTaskFields({
    groupId,
    fields,
    ioInstance,
  });
};

/**
 * After an admin extends time, deadline-failed tasks should resume as active
 * with a fresh completion window from "now".
 */
const reactivateTaskAfterExtension = (task, now = new Date()) => {
  if (!task || task.completed) return false;
  if (!task.failed) return false;
  task.failed = false;
  task.completed = false;
  task.active = true;
  task.completedAt = null;
  task.onTime = true;
  task.startedAt = now;
  return true;
};

const syncEstimatedDurationFromMemberEstimate = (task, memberEmail) => {
  if (!task || !memberEmail || !Array.isArray(task.groupMemberEstimates)) {
    return;
  }
  const normalized = String(memberEmail).toLowerCase();
  const row = task.groupMemberEstimates.find(
    (e) => String(e?.email || "").toLowerCase() === normalized,
  );
  const mins = Number(row?.estimatedMinutes);
  if (Number.isFinite(mins) && mins > 0) {
    task.estimatedDuration = Math.round(mins);
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

    const admin = await Admin.findOne({ email });
    if (admin) {
      const adminMatch = await verifyPassword(admin.password, password);
      if (adminMatch) {
        await upgradePasswordIfNeeded(admin, password);
        return res.json({ success: true, role: "admin" });
      }
    }

    const employee = await Employee.findOne({ email });
    if (!employee) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    if (employee.isArchived) {
      return res.status(403).json({ error: "Employee account is archived" });
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

    const employeeMatch = await verifyPassword(employee.password, password);
    if (!employeeMatch) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    await upgradePasswordIfNeeded(employee, password);

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

    employee.password = await bcrypt.hash(newPassword, 10);
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

    employee.password = await bcrypt.hash(newPassword, 10);
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
    const includeArchived = String(req.query.includeArchived || "") === "true";
    let employees = await Employee.find(
      includeArchived ? {} : { isArchived: { $ne: true } },
    );
    const groupIds = collectGroupIdsFromEmployees(employees);
    if (groupIds.size > 0) {
      const ioInstance = req.app.get("io");
      for (const groupId of groupIds) {
        await normalizeGroupTaskData({ groupId, ioInstance });
      }
      employees = await Employee.find(
        includeArchived ? {} : { isArchived: { $ne: true } },
      );
    }
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

// Update employee profile details without touching task history.
app.patch("/api/employees/:email/profile", async (req, res) => {
  try {
    const currentEmail = String(req.params.email || "")
      .trim()
      .toLowerCase();
    const nextEmail = String(req.body?.email || currentEmail)
      .trim()
      .toLowerCase();
    const existing = await Employee.findOne({ email: currentEmail });
    if (!existing) return res.status(404).json({ error: "Employee not found" });

    if (nextEmail !== currentEmail) {
      const duplicate = await Employee.findOne({ email: nextEmail });
      if (duplicate) {
        return res.status(409).json({ error: "Employee email already exists" });
      }
    }

    existing.firstName = String(
      req.body?.firstName || existing.firstName || "",
    ).trim();
    existing.lastName = String(
      req.body?.lastName ?? existing.lastName ?? "",
    ).trim();
    existing.email = nextEmail;
    existing.role = String(
      req.body?.role || existing.role || "employee",
    ).trim();
    await existing.save();

    const ioInstance = req.app.get("io");
    ioInstance?.emit("employeeUpdated", {
      email: existing.email,
      employee: existing,
    });

    return res.json(existing);
  } catch (err) {
    console.error("Update employee profile error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// Soft-delete employee access while preserving historical task/productivity data.
app.delete("/api/employees/:email", async (req, res) => {
  try {
    const email = String(req.params.email || "")
      .trim()
      .toLowerCase();
    const employee = await Employee.findOneAndUpdate(
      { email },
      {
        $set: {
          isArchived: true,
          archivedAt: new Date(),
          isActivated: false,
        },
      },
      { new: true },
    );
    if (!employee) return res.status(404).json({ error: "Employee not found" });

    const ioInstance = req.app.get("io");
    ioInstance?.emit("employeeUpdated", { email, employee });
    return res.json({
      success: true,
      employee,
      message: "Employee archived. Historical task data is preserved.",
    });
  } catch (err) {
    console.error("Archive employee error:", err);
    return res.status(500).json({ error: "Server error" });
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

      const groupIds = collectGroupIdsFromEmployees([emp]);
      if (groupIds.size > 0) {
        const ioInstance = req.app.get("io");
        for (const groupId of groupIds) {
          await normalizeGroupTaskData({ groupId, ioInstance });
        }
        emp = await Employee.findOne({ email: req.params.email });
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
    const employeeEmail = String(req.params.email || "")
      .trim()
      .toLowerCase();

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
    let completionBlocked = false;
    let completionBlockReason = "";
    const pendingChatMessages = [];

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

          const wasActive = Boolean(previousTask?.active);
          const becameActive = !wasActive && Boolean(task.active);
          if (becameActive && !task.groupTask && task.chatEnabled) {
            pendingChatMessages.push({
              taskKey: buildTaskIdentityKey(task),
              message: `${employeeEmail} accepted the task`,
            });
          }

          const prevDeadline = previousTask?.taskDate
            ? new Date(previousTask.taskDate).getTime()
            : Number.NaN;
          const nextDeadline = task.taskDate
            ? new Date(task.taskDate).getTime()
            : Number.NaN;
          if (
            Number.isFinite(prevDeadline) &&
            Number.isFinite(nextDeadline) &&
            nextDeadline > prevDeadline &&
            isChatEnabledForTask(task)
          ) {
            pendingChatMessages.push({
              taskKey: buildTaskIdentityKey(task),
              message: "Task deadline extended by admin",
            });
          }

          if (!prevCompleted && nowCompleted) {
            if (!canMarkTaskComplete(task, employeeEmail)) {
              completionBlocked = true;
              completionBlockReason =
                "Please complete all your assigned subtasks before marking task as complete";
            }
          }

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

        const wasActive = Boolean(previousTask?.active);
        const becameActive = !wasActive && Boolean(task.active);
        if (becameActive && !task.groupTask && task.chatEnabled) {
          pendingChatMessages.push({
            taskKey: buildTaskIdentityKey(task),
            message: `${employeeEmail} accepted the task`,
          });
        }

        const prevDeadline = previousTask?.taskDate
          ? new Date(previousTask.taskDate).getTime()
          : Number.NaN;
        const nextDeadline = task.taskDate
          ? new Date(task.taskDate).getTime()
          : Number.NaN;
        if (
          Number.isFinite(prevDeadline) &&
          Number.isFinite(nextDeadline) &&
          nextDeadline > prevDeadline &&
          isChatEnabledForTask(task)
        ) {
          pendingChatMessages.push({
            taskKey: buildTaskIdentityKey(task),
            message: "Task deadline extended by admin",
          });
        }

        if (!prevCompleted && nowCompleted) {
          if (!canMarkTaskComplete(task, employeeEmail)) {
            completionBlocked = true;
            completionBlockReason =
              "Please complete all your assigned subtasks before marking task as complete";
          }
        }

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

    if (completionBlocked) {
      return res.status(400).json({ error: completionBlockReason });
    }

    if (hadOutcomeTransition) {
      // Force next insights request to recompute using fresh post-completion data.
      update.lastInsightUpdate = null;
      update.storedInsights = [];
      update.storedInsightAnalysis = null;
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

      if (pendingChatMessages.length > 0) {
        for (const entry of pendingChatMessages) {
          const task = emp.tasks.find(
            (candidate) => buildTaskIdentityKey(candidate) === entry.taskKey,
          );
          if (!task || !isChatOpenForTask(task)) continue;
          const chatMessage = buildChatMessage({
            senderName: "System",
            message: entry.message,
            type: "system",
          });
          await appendChatMessageForTask({
            employee: emp,
            task,
            chatMessage,
            ioInstance,
          });
        }
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

// Soft-delete a single task (admin action)
app.post("/api/employees/:email/tasks/:taskId/delete", async (req, res) => {
  try {
    const email = String(req.params.email || "")
      .trim()
      .toLowerCase();
    const taskId = String(req.params.taskId || "").trim();
    const employee = await Employee.findOne({ email });
    if (!employee) return res.status(404).json({ error: "Employee not found" });

    const task = employee.tasks.id(taskId);
    if (!task) return res.status(404).json({ error: "Task not found" });
    if (task.groupTask && task.groupId) {
      return res
        .status(400)
        .json({ error: "Use group task delete for shared tasks" });
    }

    task.isDeleted = true;
    task.deletedAt = new Date();
    employee.taskCounts = computeTaskCounts(employee.tasks);
    await employee.save();

    const ioInstance = req.app.get("io");
    ioInstance?.emit("employeeUpdated", { email: employee.email, employee });
    ioInstance?.emit("taskStatusChanged", { email: employee.email, employee });

    return res.json({ success: true, employee });
  } catch (err) {
    console.error("Delete task error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// Add new task to employee
app.post("/api/employees/:email/tasks", async (req, res) => {
  try {
    const emp = await Employee.findOne({ email: req.params.email });
    if (emp) {
      if (req.body?.taskDate && isTaskDueDateInPast(req.body.taskDate)) {
        return res.status(400).json({
          error: "Task due date cannot be in the past.",
        });
      }
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
      ioInstance?.emit("employeeUpdated", {
        email: emp.email,
        employee: emp,
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

// Add a shared group task to multiple employees without changing single-task behavior.
app.post("/api/group-tasks", async (req, res) => {
  try {
    const emails = Array.from(
      new Set(
        (Array.isArray(req.body?.emails) ? req.body.emails : [])
          .map((email) =>
            String(email || "")
              .trim()
              .toLowerCase(),
          )
          .filter(Boolean),
      ),
    );
    if (emails.length < 2) {
      return res
        .status(400)
        .json({ error: "At least two employee emails are required" });
    }

    const employees = await Employee.find({
      email: { $in: emails },
      isArchived: { $ne: true },
    });
    if (employees.length !== emails.length) {
      return res
        .status(404)
        .json({ error: "One or more employees were not found" });
    }

    const now = new Date();
    if (req.body?.taskDate && isTaskDueDateInPast(req.body.taskDate)) {
      return res.status(400).json({
        error: "Task due date cannot be in the past.",
      });
    }

    const groupId = `group-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const members = buildGroupMembers(employees);
    const requestedEstimatedDuration = Number(req.body.estimatedDuration);
    const hasManualEstimate =
      Number.isFinite(requestedEstimatedDuration) &&
      requestedEstimatedDuration > 0;
    const baseTask = {
      taskTitle: req.body.taskTitle,
      taskDescription: req.body.taskDescription,
      taskDate: req.body.taskDate,
      category: req.body.category,
      estimatedDuration: hasManualEstimate
        ? normalizeEstimatedDurationMinutes(requestedEstimatedDuration, 60)
        : 0,
      acceptanceTimeLimitMinutes:
        Number(req.body.acceptanceTimeLimitMinutes) || 0,
      aiEstimationPending: !hasManualEstimate,
      assignedAt: now,
      createdAt: now,
      newTask: true,
      active: false,
      completed: false,
      failed: false,
      notAccepted: false,
      groupTask: true,
      groupId,
      groupMembers: members,
      groupAcceptedEmails: [],
      chatEnabled: true,
      chatClosed: false,
      aiPriority: "Medium",
      aiPriorityReason: "Analyzing task priority and duration...",
    };

    if (baseTask.acceptanceTimeLimitMinutes > 0) {
      baseTask.acceptanceDeadline = new Date(
        now.getTime() + baseTask.acceptanceTimeLimitMinutes * 60 * 1000,
      );
    }

    const updatedEmployees = [];
    for (const employee of employees) {
      employee.tasks.push({ ...baseTask });
      employee.taskCounts = employee.taskCounts || {
        active: 0,
        newTask: 0,
        completed: 0,
        failed: 0,
      };
      employee.taskCounts.newTask += 1;
      await employee.save();
      updatedEmployees.push(employee);
    }

    const ioInstance = req.app.get("io");
    updatedEmployees.forEach((employee) => {
      ioInstance?.emit("taskCreated", {
        email: employee.email,
        task: employee.tasks[employee.tasks.length - 1],
      });
      ioInstance?.emit("employeeUpdated", {
        email: employee.email,
        employee,
      });
    });

    enrichGroupTaskAiMetadataInBackground({
      groupId,
      baseTask,
      hasManualEstimate,
      ioInstance,
    }).catch((err) => {
      console.warn(
        "Background group task priority/estimate enrichment failed:",
        err.message,
      );
    });

    return res.status(201).json({
      success: true,
      groupId,
      employees: updatedEmployees,
    });
  } catch (err) {
    console.error("Create group task error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/group-tasks/:groupId/accept", async (req, res) => {
  try {
    const groupId = req.params.groupId;
    const employeeEmail = String(req.body?.employeeEmail || "")
      .trim()
      .toLowerCase();
    const now = new Date();
    const employees = await Employee.find({ "tasks.groupId": groupId });
    const existingAcceptedEmails = new Set(
      employees.flatMap((employee) => {
        const task = employee.tasks.find((item) => item.groupId === groupId);
        return Array.isArray(task?.groupAcceptedEmails)
          ? task.groupAcceptedEmails
          : [];
      }),
    );
    const isNewAcceptance = !existingAcceptedEmails.has(employeeEmail);
    const acceptedEmails = Array.from(
      new Set([...existingAcceptedEmails, employeeEmail]),
    );

    const updated = [];
    for (const employee of employees) {
      const task = employee.tasks.find((item) => item.groupId === groupId);
      if (!task) continue;
      task.groupAcceptedEmails = acceptedEmails;
      task.groupMembers = (task.groupMembers || []).map((member) => ({
        ...(member.toObject?.() || member),
        accepted: acceptedEmails.includes(String(member.email).toLowerCase()),
        acceptedAt:
          acceptedEmails.includes(String(member.email).toLowerCase()) &&
          String(member.email).toLowerCase() === employeeEmail
            ? now
            : member.acceptedAt,
      }));
      if (employee.email === employeeEmail) {
        task.newTask = false;
        task.active = true;
        task.acceptedAt = now;
        task.startedAt = task.startedAt || now;
      }
      employee.taskCounts = computeTaskCounts(employee.tasks);
      await employee.save();
      updated.push(employee);
    }

    const ioInstance = req.app.get("io");
    updated.forEach((employee) => {
      ioInstance?.emit("employeeUpdated", { email: employee.email, employee });
      ioInstance?.emit("taskStatusChanged", {
        email: employee.email,
        employee,
      });
    });

    if (isNewAcceptance) {
      const systemMessage = buildChatMessage({
        senderName: "System",
        message: `${employeeEmail} accepted the task`,
        type: "system",
      });
      await appendChatMessageForGroup({
        groupId,
        chatMessage: systemMessage,
        ioInstance,
      });
    }

    await normalizeGroupTaskData({ groupId, ioInstance });

    return res.json({ success: true, acceptedEmails, employees: updated });
  } catch (err) {
    console.error("Accept group task error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

app.post(
  "/api/group-tasks/:groupId/subtasks/:index/toggle",
  async (req, res) => {
    try {
      const groupId = req.params.groupId;
      const index = Number(req.params.index);
      const employeeEmail = String(req.body?.employeeEmail || "")
        .trim()
        .toLowerCase();
      const employees = await Employee.find({ "tasks.groupId": groupId });
      const employee = employees.find(
        (candidate) =>
          String(candidate.email || "")
            .trim()
            .toLowerCase() === employeeEmail,
      );
      const employeeTask = employee?.tasks?.find(
        (task) => task.groupId === groupId,
      );
      if (!employeeTask) {
        return res.status(404).json({ error: "Employee task not found" });
      }
      if (employeeTask.completed) {
        return res.status(409).json({ error: "Task is already completed" });
      }
      const sourceTask =
        employees
          .flatMap((employee) => employee.tasks || [])
          .find(
            (task) =>
              task.groupId === groupId &&
              Array.isArray(task.groupStepAssignments) &&
              task.groupStepAssignments.length > 0,
          ) ||
        employees
          .flatMap((employee) => employee.tasks || [])
          .find((task) => task.groupId === groupId);
      const assignments = Array.isArray(sourceTask?.groupStepAssignments)
        ? sourceTask.groupStepAssignments.map(
            (item) => item.toObject?.() || item,
          )
        : [];
      const target = assignments[index];
      if (!target) return res.status(404).json({ error: "Subtask not found" });
      if (String(target.assignedEmail || "").toLowerCase() !== employeeEmail) {
        return res.status(403).json({
          error: "Only the assigned employee can update this subtask",
        });
      }

      const isCompleting = req.body?.completed !== undefined ? Boolean(req.body.completed) : !target.completed;
      assignments[index] = {
        ...target,
        completed: isCompleting,
        completedBy: isCompleting ? employeeEmail : null,
        completedAt: isCompleting ? new Date() : null,
      };

      const updatedEmployees = [];
      for (const emp of employees) {
        const task = emp.tasks.find((item) => item.groupId === groupId);
        if (!task) continue;
        task.groupStepAssignments = assignments;
        updatedEmployees.push(emp);
      }

      await Promise.all(updatedEmployees.map((emp) => emp.save()));

      const assignmentsUpdated = assignments;

      const ioInstance = req.app.get("io");
      updatedEmployees.forEach((emp) => {
        ioInstance?.emit("employeeUpdated", {
          email: emp.email,
          employee: emp,
        });
        ioInstance?.emit("taskStatusChanged", {
          email: emp.email,
          employee: emp,
        });
      });
      if (isCompleting) {
        const systemMessage = buildChatMessage({
          senderName: "System",
          message: `${employeeEmail} completed a subtask`,
          type: "system",
        });
        await appendChatMessageForGroup({
          groupId,
          chatMessage: systemMessage,
          ioInstance,
        });
      }
      return res.json({ success: true, assignments: assignmentsUpdated, employees: updatedEmployees });
    } catch (err) {
      console.error("Toggle group subtask error:", err);
      return res.status(500).json({ error: "Server error" });
    }
  },
);

app.post(
  "/api/employees/:email/tasks/:taskId/subtasks/:index/toggle",
  async (req, res) => {
    try {
      const email = String(req.params.email || "")
        .trim()
        .toLowerCase();
      const taskId = String(req.params.taskId || "").trim();
      const index = Number(req.params.index);
      const employee = await Employee.findOne({ email });
      if (!employee) {
        return res.status(404).json({ error: "Employee not found" });
      }

      const task = employee.tasks.id(taskId);
      if (!task) return res.status(404).json({ error: "Task not found" });
      if (task.groupTask && task.groupId) {
        return res
          .status(400)
          .json({ error: "Use group task subtask endpoint" });
      }
      if (task.completed) {
        return res.status(409).json({ error: "Task is already completed" });
      }

      const steps = Array.isArray(task.explainSteps) ? task.explainSteps : [];
      if (!steps.length) {
        return res
          .status(400)
          .json({ error: "No subtasks available for this task" });
      }
      if (!Number.isInteger(index) || index < 0 || index >= steps.length) {
        return res.status(404).json({ error: "Subtask not found" });
      }

      const currentChecks = Array.isArray(task.explainStepChecks)
        ? task.explainStepChecks
        : [];
      const normalizedChecks = steps.map((_, idx) =>
        Boolean(currentChecks[idx]),
      );
      const isCompleting = req.body?.completed !== undefined ? Boolean(req.body.completed) : !normalizedChecks[index];
      normalizedChecks[index] = isCompleting;
      task.explainStepChecks = normalizedChecks;
      
      await employee.save();
      const updatedEmployee = employee;
      const updatedTask = task;
      const newNormalizedChecks = normalizedChecks;

      const ioInstance = req.app.get("io");
      ioInstance?.emit("employeeUpdated", { email: updatedEmployee.email, employee: updatedEmployee });
      ioInstance?.emit("taskStatusChanged", {
        email: updatedEmployee.email,
        employee: updatedEmployee,
      });
      if (isCompleting) {
        const systemMessage = buildChatMessage({
          senderName: "System",
          message: `${email} completed a subtask`,
          type: "system",
        });
        await appendChatMessageForTask({
          employee,
          task,
          chatMessage: systemMessage,
          ioInstance,
        });
      }

      return res.json({
        success: true,
        stepChecks: newNormalizedChecks,
        task: updatedTask,
      });
    } catch (err) {
      console.error("Toggle subtask error:", err);
      return res.status(500).json({ error: "Server error" });
    }
  },
);

app.get("/api/employees/:email/tasks/:taskId/chat", async (req, res) => {
  try {
    const email = String(req.params.email || "")
      .trim()
      .toLowerCase();
    const taskId = String(req.params.taskId || "").trim();
    const employee = await Employee.findOne({ email });
    if (!employee) {
      return res.status(404).json({ error: "Employee not found" });
    }
    const task = employee.tasks.id(taskId);
    if (!task) return res.status(404).json({ error: "Task not found" });
    return res.json({
      taskId,
      chatEnabled: isChatEnabledForTask(task),
      chatClosed: Boolean(task.chatClosed),
      messages: Array.isArray(task.chatMessages) ? task.chatMessages : [],
    });
  } catch (err) {
    console.error("Load task chat error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

app.post(
  "/api/employees/:email/tasks/:taskId/chat/messages",
  async (req, res) => {
    try {
      const email = String(req.params.email || "")
        .trim()
        .toLowerCase();
      const taskId = String(req.params.taskId || "").trim();
      const messageText = String(req.body?.message || "").trim();
      if (!messageText) {
        return res.status(400).json({ error: "Message is required" });
      }
      const employee = await Employee.findOne({ email });
      if (!employee) {
        return res.status(404).json({ error: "Employee not found" });
      }
      const task = employee.tasks.id(taskId);
      if (!task) return res.status(404).json({ error: "Task not found" });
      if (!isChatEnabledForTask(task)) {
        return res.status(403).json({ error: "Chat is not enabled" });
      }
      if (!isChatOpenForTask(task)) {
        return res.status(409).json({ error: "Chat is closed" });
      }
      const messageType = req.body?.type === "assistant" ? "assistant" : "user";
      const chatMessage = buildChatMessage({
        senderName: req.body?.senderName || "Member",
        senderEmail: req.body?.senderEmail,
        senderRole: req.body?.senderRole,
        message: messageText,
        type: messageType,
      });
      const ioInstance = req.app.get("io");
      await appendChatMessageForTask({
        employee,
        task,
        chatMessage,
        ioInstance,
      });
      return res.json({ success: true, message: chatMessage });
    } catch (err) {
      console.error("Post task chat message error:", err);
      return res.status(500).json({ error: "Server error" });
    }
  },
);

app.post(
  "/api/employees/:email/tasks/:taskId/chat/enable",
  async (req, res) => {
    try {
      const email = String(req.params.email || "")
        .trim()
        .toLowerCase();
      const taskId = String(req.params.taskId || "").trim();
      const employee = await Employee.findOne({ email });
      if (!employee) {
        return res.status(404).json({ error: "Employee not found" });
      }
      const task = employee.tasks.id(taskId);
      if (!task) return res.status(404).json({ error: "Task not found" });
      if (task.groupTask && task.groupId) {
        return res
          .status(400)
          .json({ error: "Group tasks already have chat enabled" });
      }
      task.chatEnabled = true;
      await employee.save();
      const ioInstance = req.app.get("io");
      ioInstance?.emit("taskChatEnabled", { taskId, email });
      ioInstance?.emit("employeeUpdated", { email, employee });
      return res.json({ success: true, task });
    } catch (err) {
      console.error("Enable task chat error:", err);
      return res.status(500).json({ error: "Server error" });
    }
  },
);

app.post("/api/employees/:email/tasks/:taskId/chat/close", async (req, res) => {
  try {
    const email = String(req.params.email || "")
      .trim()
      .toLowerCase();
    const taskId = String(req.params.taskId || "").trim();
    const employee = await Employee.findOne({ email });
    if (!employee) {
      return res.status(404).json({ error: "Employee not found" });
    }
    const task = employee.tasks.id(taskId);
    if (!task) return res.status(404).json({ error: "Task not found" });
    task.chatClosed = true;
    await employee.save();
    const ioInstance = req.app.get("io");
    ioInstance?.emit("taskChatClosed", { taskId, email });
    ioInstance?.emit("employeeUpdated", { email, employee });
    return res.json({ success: true, taskId });
  } catch (err) {
    console.error("Close task chat error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/group-tasks/:groupId/chat", async (req, res) => {
  try {
    const groupId = req.params.groupId;
    const employees = await Employee.find({ "tasks.groupId": groupId });
    if (!employees.length) {
      return res.status(404).json({ error: "Group task not found" });
    }
    const task = employees
      .flatMap((employee) => employee.tasks || [])
      .find((item) => item.groupId === groupId);
    if (!task) {
      return res.status(404).json({ error: "Group task not found" });
    }
    return res.json({
      groupId,
      chatClosed: Boolean(task.chatClosed),
      chatEnabled: true,
      messages: Array.isArray(task.chatMessages) ? task.chatMessages : [],
    });
  } catch (err) {
    console.error("Load group chat error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/group-tasks/:groupId/chat/messages", async (req, res) => {
  try {
    const groupId = req.params.groupId;
    const messageText = String(req.body?.message || "").trim();
    if (!messageText) {
      return res.status(400).json({ error: "Message is required" });
    }
    const messageType = req.body?.type === "assistant" ? "assistant" : "user";
    const chatMessage = buildChatMessage({
      senderName: req.body?.senderName || "Member",
      senderEmail: req.body?.senderEmail,
      senderRole: req.body?.senderRole,
      message: messageText,
      type: messageType,
    });
    const ioInstance = req.app.get("io");
    const updated = await appendChatMessageForGroup({
      groupId,
      chatMessage,
      ioInstance,
    });
    if (!updated.length) {
      return res.status(409).json({ error: "Chat is closed" });
    }
    return res.json({ success: true, message: chatMessage });
  } catch (err) {
    console.error("Post group chat message error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/group-tasks/:groupId/chat/close", async (req, res) => {
  try {
    const groupId = req.params.groupId;
    const employees = await Employee.find({ "tasks.groupId": groupId });
    if (!employees.length) {
      return res.status(404).json({ error: "Group task not found" });
    }
    const updated = [];
    for (const employee of employees) {
      const task = employee.tasks.find((item) => item.groupId === groupId);
      if (!task) continue;
      task.chatClosed = true;
      await employee.save();
      updated.push(employee);
    }
    const ioInstance = req.app.get("io");
    ioInstance?.emit("taskChatClosed", { groupId });
    updated.forEach((employee) =>
      ioInstance?.emit("employeeUpdated", {
        email: employee.email,
        employee,
      }),
    );
    return res.json({ success: true, groupId });
  } catch (err) {
    console.error("Close group chat error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/employees/:email/tasks/:taskId/extend", async (req, res) => {
  try {
    const email = String(req.params.email || "")
      .trim()
      .toLowerCase();
    const taskId = String(req.params.taskId || "").trim();
    const days = Number(req.body?.days || 0);
    if (!Number.isFinite(days) || days <= 0) {
      return res.status(400).json({ error: "Days must be greater than 0" });
    }
    const employee = await Employee.findOne({ email });
    if (!employee) {
      return res.status(404).json({ error: "Employee not found" });
    }
    const task = employee.tasks.id(taskId);
    if (!task) return res.status(404).json({ error: "Task not found" });

    const addedMinutes = Math.round(days * 24 * 60);
    task.estimatedDuration = Math.max(
      0,
      Number(task.estimatedDuration || 0) + addedMinutes,
    );
    const nextDate = addDaysToTaskDate(task.taskDate, days);
    if (nextDate) {
      task.taskDate = nextDate.toISOString().slice(0, 10);
    }

    const now = new Date();
    reactivateTaskAfterExtension(task, now);
    applyTaskTimeouts(employee);
    employee.taskCounts = computeTaskCounts(employee.tasks);

    await employee.save();
    const ioInstance = req.app.get("io");
    ioInstance?.emit("employeeUpdated", { email: employee.email, employee });
    ioInstance?.emit("taskStatusChanged", {
      email: employee.email,
      employee,
    });

    const systemMessage = buildChatMessage({
      senderName: "System",
      message: "Deadline extended by admin",
      type: "system",
    });
    await appendChatMessageForTask({
      employee,
      task,
      chatMessage: systemMessage,
      ioInstance,
    });

    return res.json({ success: true, task });
  } catch (err) {
    console.error("Extend task error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/group-tasks/:groupId/extend", async (req, res) => {
  try {
    const groupId = req.params.groupId;
    const days = Number(req.body?.days || 0);
    const memberEmail = String(req.body?.memberEmail || "")
      .trim()
      .toLowerCase();
    if (!Number.isFinite(days) || days <= 0) {
      return res.status(400).json({ error: "Days must be greater than 0" });
    }
    const employees = await Employee.find({ "tasks.groupId": groupId });
    if (!employees.length) {
      return res.status(404).json({ error: "Group task not found" });
    }
    const addedMinutes = Math.round(days * 24 * 60);
    const updated = [];
    const now = new Date();

    for (const employee of employees) {
      const task = employee.tasks.find((item) => item.groupId === groupId);
      if (!task) continue;

      if (!memberEmail) {
        task.estimatedDuration = Math.max(
          0,
          Number(task.estimatedDuration || 0) + addedMinutes,
        );
        const nextDate = addDaysToTaskDate(task.taskDate, days);
        if (nextDate) {
          task.taskDate = nextDate.toISOString().slice(0, 10);
        }
        reactivateTaskAfterExtension(task, now);
      }

      if (Array.isArray(task.groupMemberEstimates)) {
        task.groupMemberEstimates = task.groupMemberEstimates.map((entry) => {
          if (
            memberEmail &&
            String(entry?.email || "").toLowerCase() !== memberEmail
          ) {
            return entry;
          }
          const nextEstimate = Math.max(
            0,
            Number(entry?.estimatedMinutes || 0) + addedMinutes,
          );
          return { ...entry, estimatedMinutes: nextEstimate };
        });
      }

      if (memberEmail) {
        const empEmail = String(employee.email || "").toLowerCase();
        if (empEmail === memberEmail) {
          syncEstimatedDurationFromMemberEstimate(task, memberEmail);
          reactivateTaskAfterExtension(task, now);
        }
      }

      applyTaskTimeouts(employee);
      employee.taskCounts = computeTaskCounts(employee.tasks);

      await employee.save();
      updated.push(employee);
    }

    const ioInstance = req.app.get("io");
    updated.forEach((employee) => {
      ioInstance?.emit("employeeUpdated", {
        email: employee.email,
        employee,
      });
      ioInstance?.emit("taskStatusChanged", {
        email: employee.email,
        employee,
      });
    });
    ioInstance?.emit("taskStatusChanged", { groupId });

    const systemMessage = buildChatMessage({
      senderName: "System",
      message: "Deadline extended by admin",
      type: "system",
    });
    await appendChatMessageForGroup({
      groupId,
      chatMessage: systemMessage,
      ioInstance,
    });

    return res.json({ success: true, groupId });
  } catch (err) {
    console.error("Extend group task error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// Soft-delete a group task across all members (admin action)
app.post("/api/group-tasks/:groupId/delete", async (req, res) => {
  try {
    const groupId = req.params.groupId;
    const employees = await Employee.find({ "tasks.groupId": groupId });
    if (!employees.length) {
      return res.status(404).json({ error: "Group task not found" });
    }

    const now = new Date();
    const updated = [];
    for (const employee of employees) {
      const task = employee.tasks.find((item) => item.groupId === groupId);
      if (!task) continue;
      task.isDeleted = true;
      task.deletedAt = now;
      employee.taskCounts = computeTaskCounts(employee.tasks);
      await employee.save();
      updated.push(employee);
    }

    const ioInstance = req.app.get("io");
    updated.forEach((employee) => {
      ioInstance?.emit("employeeUpdated", { email: employee.email, employee });
      ioInstance?.emit("taskStatusChanged", {
        email: employee.email,
        employee,
      });
    });

    return res.json({ success: true, groupId, employees: updated });
  } catch (err) {
    console.error("Delete group task error:", err);
    return res.status(500).json({ error: "Server error" });
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
    const found = await Admin.findOne({ email });
    if (found && (await verifyPassword(found.password, password))) {
      await upgradePasswordIfNeeded(found, password);
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
