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
  buildGroupExplainTaskPrompt,
  buildRuleBasedTaskGuidance,
} from "./geminiPrompts.js";

const router = express.Router();

const explainInFlight = new Map();
const explainCooldownUntil = new Map();

const getTaskLookupKey = ({
  employeeEmail,
  taskId,
  taskLookup,
  title,
  groupId,
}) => {
  if (groupId) {
    return ["group", groupId].join("::");
  }

  return [
    employeeEmail || "unknown",
    taskId || "",
    taskLookup?.taskTitle || title || "",
    taskLookup?.taskDate || "",
  ].join("::");
};

const getExistingTaskExplanation = (task) => {
  const hasGroupAssignments =
    Array.isArray(task?.groupStepAssignments) &&
    task.groupStepAssignments.length > 0;
  const hasExplainSteps =
    Array.isArray(task?.explainSteps) && task.explainSteps.length > 0;
  const hasSummary = Boolean(task?.explainSummary);

  if (!hasSummary && !hasExplainSteps && !hasGroupAssignments) return null;
  return {
    summary: task.explainSummary || "Task guidance is available.",
    steps: Array.isArray(task.explainSteps) ? task.explainSteps : [],
    estimated_time: task.explainEstimatedTime || "N/A",
    stepAssignments: hasGroupAssignments ? task.groupStepAssignments : [],
    stepChecks: Array.isArray(task.explainStepChecks)
      ? task.explainStepChecks
      : [],
    source: task.explainSource || "AI",
    fromCache: true,
  };
};

const assignGroupSteps = ({ steps = [], members = [] }) => {
  if (!steps.length || !members.length) return [];

  const normalizedMembers = members.map((member) => ({
    ...member,
    profile: String(member.role || "")
      .toLowerCase()
      .trim(),
  }));

  const scoreMemberForStep = (stepText, member) => {
    const lower = String(stepText || "").toLowerCase();
    const profile = member.profile || "";
    let score = 0;

    if (/design|wireframe|visual|ui|ux/.test(lower)) {
      score += /design|ui|ux/.test(profile) ? 3 : 0;
    }
    if (/data|metric|report|analysis|dashboard/.test(lower)) {
      score += /analytic|data/.test(profile) ? 3 : 0;
    }
    if (/test|qa|verify|bug/.test(lower)) {
      score += /quality|qa|test/.test(profile) ? 3 : 0;
    }
    if (/plan|coordinate|review|stakeholder/.test(lower)) {
      score += /manager|coordination|lead|owner/.test(profile) ? 3 : 0;
    }
    if (/code|api|build|implement|develop/.test(lower)) {
      score += /dev|engineer|developer|development/.test(profile) ? 3 : 0;
    }

    if (score === 0) {
      score += /intern|assistant|support/.test(profile) ? 1 : 0;
    }

    return score;
  };

  const assignments = steps.map((step, idx) => {
    let bestIndex = idx % normalizedMembers.length;
    let bestScore = -1;
    normalizedMembers.forEach((member, memberIdx) => {
      const score = scoreMemberForStep(step, member);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = memberIdx;
      }
    });

    const chosen = normalizedMembers[bestIndex];
    return {
      step,
      assignedEmail: chosen.email,
      assignedName: chosen.name || chosen.email,
      completed: false,
    };
  });

  const memberAssignmentCounts = normalizedMembers.reduce((acc, member) => {
    acc[member.email] = 0;
    return acc;
  }, {});

  assignments.forEach((assignment) => {
    if (assignment.assignedEmail in memberAssignmentCounts) {
      memberAssignmentCounts[assignment.assignedEmail] += 1;
    }
  });

  const membersWithoutAssignments = normalizedMembers.filter(
    (member) => memberAssignmentCounts[member.email] === 0,
  );

  if (membersWithoutAssignments.length && steps.length >= members.length) {
    membersWithoutAssignments.forEach((member, memberIdx) => {
      let reassigned = false;
      for (let i = 0; i < assignments.length; i += 1) {
        const currentAssignee = assignments[i].assignedEmail;
        if (memberAssignmentCounts[currentAssignee] > 1) {
          assignments[i] = {
            ...assignments[i],
            assignedEmail: member.email,
            assignedName: member.name || member.email,
          };
          memberAssignmentCounts[currentAssignee] -= 1;
          memberAssignmentCounts[member.email] += 1;
          reassigned = true;
          break;
        }
      }

      if (!reassigned) {
        const fallbackIndex = memberIdx % assignments.length;
        const fallbackCurrent = assignments[fallbackIndex].assignedEmail;
        assignments[fallbackIndex] = {
          ...assignments[fallbackIndex],
          assignedEmail: member.email,
          assignedName: member.name || member.email,
        };
        if (memberAssignmentCounts[fallbackCurrent] > 0) {
          memberAssignmentCounts[fallbackCurrent] -= 1;
        }
        memberAssignmentCounts[member.email] += 1;
      }
    });
  }

  return assignments;
};

const normalizeMemberName = (value) =>
  String(value || "")
    .trim()
    .toLowerCase();

const buildMemberHistorySummary = (employee = {}) => {
  const tasks = Array.isArray(employee.tasks) ? employee.tasks : [];
  const candidates = tasks
    .filter(
      (task) => task && !task.isDeleted && (task.completed || task.active),
    )
    .sort((a, b) => {
      const aTs = new Date(
        a.completedAt || a.startedAt || a.assignedAt || 0,
      ).getTime();
      const bTs = new Date(
        b.completedAt || b.startedAt || b.assignedAt || 0,
      ).getTime();
      return bTs - aTs;
    })
    .slice(0, 2)
    .map((task) => String(task.taskTitle || "").trim())
    .filter(Boolean);

  if (!candidates.length) return "";
  const summary = candidates.join("; ");
  return summary.length > 120 ? `${summary.slice(0, 117)}...` : summary;
};

const resolveAssigneeByName = (assignedTo, members = []) => {
  const normalizedAssigned = normalizeMemberName(assignedTo);
  if (!normalizedAssigned) return null;

  const exact = members.find((member) => {
    const name = normalizeMemberName(member.name);
    const email = normalizeMemberName(member.email);
    return name === normalizedAssigned || email === normalizedAssigned;
  });
  if (exact) return exact;

  const assignedTokens = normalizedAssigned.split(/\s+/).filter(Boolean);
  const partial = members.find((member) => {
    const nameTokens = normalizeMemberName(member.name)
      .split(/\s+/)
      .filter(Boolean);
    return assignedTokens.some((token) => nameTokens.includes(token));
  });

  return partial || null;
};

const scoreRoleMatch = (text, role) => {
  const lower = String(text || "").toLowerCase();
  const roleText = String(role || "").toLowerCase();
  let score = 0;

  if (/design|wireframe|visual|ui|ux/.test(lower)) {
    score += /design|ui|ux|designer/.test(roleText) ? 3 : 0;
  }
  if (/data|metric|report|analysis|dashboard/.test(lower)) {
    score += /data|analytic|analyst/.test(roleText) ? 3 : 0;
  }
  if (/test|qa|verify|bug/.test(lower)) {
    score += /qa|test|quality/.test(roleText) ? 3 : 0;
  }
  if (/plan|coordinate|review|stakeholder/.test(lower)) {
    score += /manager|lead|coordination|owner/.test(roleText) ? 3 : 0;
  }
  if (/code|api|build|implement|develop/.test(lower)) {
    score += /dev|engineer|developer|development/.test(roleText) ? 3 : 0;
  }
  if (/support|assist|documentation|update/.test(lower)) {
    score += /intern|assistant|support/.test(roleText) ? 1 : 0;
  }

  return score;
};

const pickMemberByRole = (text, members = []) => {
  let best = members[0] || null;
  let bestScore = -1;
  members.forEach((member) => {
    const score = scoreRoleMatch(text, member.role);
    if (score > bestScore) {
      bestScore = score;
      best = member;
    }
  });
  return best;
};

const ensureAssignmentsCoverage = (assignments = [], members = []) => {
  if (!assignments.length || !members.length) return assignments;
  if (assignments.length < members.length) return assignments;

  const counts = members.reduce((acc, member) => {
    acc[member.email] = 0;
    return acc;
  }, {});

  assignments.forEach((assignment) => {
    if (assignment.assignedEmail in counts) {
      counts[assignment.assignedEmail] += 1;
    }
  });

  const unassignedMembers = members.filter(
    (member) => counts[member.email] === 0,
  );

  unassignedMembers.forEach((member) => {
    for (let i = 0; i < assignments.length; i += 1) {
      const currentEmail = assignments[i].assignedEmail;
      if (counts[currentEmail] > 1) {
        counts[currentEmail] -= 1;
        counts[member.email] += 1;
        assignments[i] = {
          ...assignments[i],
          assignedEmail: member.email,
          assignedName: member.name || member.email,
        };
        break;
      }
    }
  });

  return assignments;
};

const normalizeGroupAssignmentsFromAi = ({ steps = [], members = [] }) => {
  if (!Array.isArray(steps) || !members.length) return [];

  const assignments = steps
    .map((step) => {
      if (!step) return null;

      if (typeof step === "string") {
        const assignee = pickMemberByRole(step, members);
        return assignee
          ? {
              step: step.trim(),
              assignedEmail: assignee.email,
              assignedName: assignee.name || assignee.email,
              completed: false,
            }
          : null;
      }

      const text = String(
        step.text || step.step || step.description || "",
      ).trim();
      if (!text) return null;

      const assignedTo = String(
        step.assigned_to ||
          step.assignedTo ||
          step.assigned ||
          step.owner ||
          "",
      ).trim();

      const matched = resolveAssigneeByName(assignedTo, members);
      const fallback = matched || pickMemberByRole(text, members);
      if (!fallback) return null;

      return {
        step: text,
        assignedEmail: fallback.email,
        assignedName: fallback.name || fallback.email,
        completed: false,
      };
    })
    .filter(Boolean);

  return ensureAssignmentsCoverage(assignments, members);
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

const normalizeExplanationPayload = (payload, fallbackPayload) => {
  const summary = String(payload?.summary || "").trim();
  const steps = Array.isArray(payload?.steps)
    ? payload.steps
        .map((step) => {
          if (typeof step === "string") {
            const text = String(step || "").trim();
            return text ? text : null;
          }
          if (step && typeof step === "object") {
            const text = String(
              step.text || step.step || step.description || "",
            ).trim();
            if (!text) return null;
            const assignedTo = String(
              step.assigned_to ||
                step.assignedTo ||
                step.assigned ||
                step.owner ||
                "",
            ).trim();
            return assignedTo ? { text, assigned_to: assignedTo } : { text };
          }
          return null;
        })
        .filter(Boolean)
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
  groupId,
  source = "AI",
}) => {
  if (!employeeEmail) return null;

  let updatedEmployee = null;
  let assignments = [];

  if (groupId) {
    const groupEmployees = await Employee.find({ "tasks.groupId": groupId });
    const groupTask = groupEmployees
      .flatMap((employee) => employee.tasks || [])
      .find((task) => task.groupId === groupId);
    const members = Array.isArray(groupTask?.groupMembers)
      ? groupTask.groupMembers.map((member) => member.toObject?.() || member)
      : [];

    const existingExplanation = getExistingTaskExplanation(groupTask);
    const resolvedSummary = existingExplanation?.summary || explanation.summary;
    const resolvedSteps =
      existingExplanation?.steps?.length > 0
        ? existingExplanation.steps
        : explanation.steps || [];
    const resolvedEstimatedTime =
      existingExplanation?.estimated_time || explanation.estimated_time;

    const normalizedStepTexts = Array.isArray(resolvedSteps)
      ? resolvedSteps
          .map((step) => {
            if (typeof step === "string") return step.trim();
            if (step && typeof step === "object") {
              return String(
                step.text || step.step || step.description || "",
              ).trim();
            }
            return "";
          })
          .filter(Boolean)
      : [];

    assignments =
      existingExplanation?.stepAssignments?.length > 0
        ? existingExplanation.stepAssignments
        : Array.isArray(groupTask?.groupStepAssignments) &&
            groupTask.groupStepAssignments.length > 0
          ? groupTask.groupStepAssignments.map(
              (item) => item.toObject?.() || item,
            )
          : normalizeGroupAssignmentsFromAi({
              steps: resolvedSteps,
              members,
            });

    if (!assignments.length && normalizedStepTexts.length > 0) {
      assignments = assignGroupSteps({
        steps: normalizedStepTexts,
        members,
      });
    }

    const totalMinutes =
      parseEstimatedMinutes(resolvedEstimatedTime) ||
      Number(groupTask?.estimatedDuration) ||
      0;
    const groupMemberEstimates = buildGroupMemberEstimates({
      assignments,
      totalMinutes,
    });

    const updatedEmployees = [];
    for (const employee of groupEmployees) {
      const task = employee.tasks.find(
        (candidate) => candidate.groupId === groupId,
      );
      if (!task) continue;
      task.explainSummary = resolvedSummary;
      task.explainSteps = normalizedStepTexts || [];
      task.explainEstimatedTime = resolvedEstimatedTime;
      task.explainSource = groupTask?.explainSource || source;
      task.groupStepAssignments = assignments;
      task.groupMemberEstimates = groupMemberEstimates;
      updatedEmployees.push(await employee.save());
    }
    return (
      updatedEmployees.find((employee) => employee.email === employeeEmail) ||
      updatedEmployees[0] ||
      null
    );
  }

  const normalizedSteps = Array.isArray(explanation.steps)
    ? explanation.steps
        .map((step) => {
          if (typeof step === "string") return step.trim();
          if (step && typeof step === "object") {
            return String(
              step.text || step.step || step.description || "",
            ).trim();
          }
          return "";
        })
        .filter(Boolean)
    : [];

  if (taskId) {
    updatedEmployee = await Employee.findOneAndUpdate(
      { email: employeeEmail, "tasks._id": taskId },
      {
        $set: {
          "tasks.$.explainSummary": explanation.summary,
          "tasks.$.explainSteps": normalizedSteps,
          "tasks.$.explainEstimatedTime": explanation.estimated_time,
          "tasks.$.explainSource": source,
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
          "tasks.$.explainSteps": normalizedSteps,
          "tasks.$.explainEstimatedTime": explanation.estimated_time,
          "tasks.$.explainSource": source,
        },
      },
      { new: true },
    );
  }

  if (updatedEmployee && normalizedSteps.length > 0) {
    const targetTask = taskId
      ? updatedEmployee.tasks.id(taskId)
      : updatedEmployee.tasks.find(
          (candidate) =>
            candidate.taskTitle === taskLookup?.taskTitle &&
            candidate.taskDate === taskLookup?.taskDate &&
            candidate.taskDescription === taskLookup?.taskDescription,
        );

    const existingChecks = Array.isArray(targetTask?.explainStepChecks)
      ? targetTask.explainStepChecks
      : [];
    if (existingChecks.length !== normalizedSteps.length) {
      const nextChecks = normalizedSteps.map((_, idx) =>
        Boolean(existingChecks[idx]),
      );
      updatedEmployee = await Employee.findOneAndUpdate(
        { email: employeeEmail, "tasks._id": targetTask?._id },
        { $set: { "tasks.$.explainStepChecks": nextChecks } },
        { new: true },
      );
    }
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
    const {
      employeeEmail,
      taskId,
      taskLookup,
      title,
      description,
      metadata,
      groupId,
    } = req.body;

    console.log("[Gemini][explain-task] Incoming payload:", {
      employeeEmail,
      taskId,
      groupId,
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
      groupId,
    });

    const fallbackExplanation = buildRuleBasedTaskGuidance({
      title,
      description,
      metadata,
    });

    let groupEmployees = null;
    if (groupId) {
      groupEmployees = await Employee.find({ "tasks.groupId": groupId });
      const groupTask = groupEmployees
        .flatMap((employee) => employee.tasks || [])
        .find((task) => task.groupId === groupId);
      const existing = getExistingTaskExplanation(groupTask);
      if (existing) {
        return res.json(existing);
      }
    } else if (employeeEmail) {
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

    const prompt = groupId
      ? buildGroupExplainTaskPrompt({
          title,
          description,
          metadata,
          members: (groupEmployees || []).map((employee) => ({
            name:
              [employee.firstName, employee.lastName]
                .filter(Boolean)
                .join(" ") || employee.email,
            role: employee.role || "employee",
            summary: buildMemberHistorySummary(employee),
          })),
        })
      : buildExplainTaskPrompt({ title, description, metadata });
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
        source: usedFallback ? "System" : "AI",
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
            groupId,
            source: usedFallback ? "System" : "AI",
          });

          const responseTask =
            groupId && updatedEmployee
              ? updatedEmployee.tasks.find((task) => task.groupId === groupId)
              : taskId && updatedEmployee
                ? updatedEmployee.tasks.id(taskId)
                : null;
          if (responseTask?.groupStepAssignments?.length) {
            responsePayload.stepAssignments = responseTask.groupStepAssignments;
          }
          if (Array.isArray(responseTask?.explainStepChecks)) {
            responsePayload.stepChecks = responseTask.explainStepChecks;
          }

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
      groupId: req.body?.groupId,
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

router.post("/task-assistant", async (req, res) => {
  try {
    const { question, task, requester, privacy } = req.body || {};
    const conversationHistory = Array.isArray(req.body?.conversationHistory)
      ? req.body.conversationHistory
      : [];
    const promptQuestion = String(question || "").trim();
    if (!promptQuestion) {
      return res.status(400).json({ error: "Question is required" });
    }

    const taskTitle = String(task?.title || task?.taskTitle || "").trim();
    const taskDescription = String(
      task?.description || task?.taskDescription || "",
    ).trim();
    const steps = Array.isArray(task?.steps) ? task.steps : [];
    const assignments = Array.isArray(task?.assignments)
      ? task.assignments
      : [];
    const members = Array.isArray(task?.members) ? task.members : [];
    
    const isGroupTask = members.length > 1;
    const toneAndRoleInstruction = isGroupTask 
      ? "You are a collaborative group assistant. Understand what each team member has done. Do not repeat obvious info or guess roles."
      : "You are a personal assistant for this employee. Understand their role and respond based on the actual task content. Do not say 'please provide context' if the task has no subtasks, instead offer to help plan.";

    const requesterName = String(requester?.name || "User");
    const requesterIdentity = `The user currently speaking to you is: ${requesterName} (${requester?.role || "employee"}). Always respond to them directly using their name if they introduce themselves or ask who they are. Never confuse their identity.`;

    const stepChecks = Array.isArray(task?.stepChecks) ? task.stepChecks : [];

    const contextLines = [
      `Title: ${taskTitle || "N/A"}`,
      `Description: ${taskDescription || "N/A"}`,
      `Task Type: ${isGroupTask ? "Group Collaborative Task" : "Single Employee Task"}`,
      `Subtasks: ${
        steps.length
          ? steps.map((step, idx) => `${idx + 1}. ${step} (Completed: ${stepChecks[idx] ? "Yes" : "No"})`).join(" | ")
          : "None defined yet"
      }`,
      `Assignments: ${
        assignments.length
          ? assignments
              .map(
                (item) =>
                  `${item.step || item.text || ""} -> ${
                    item.assignedName || item.assignedEmail || "Unassigned"
                  } (Completed: ${item.completed ? "Yes" : "No"})`,
              )
              .join(" | ")
          : "None"
      }`,
      `Team Members: ${
        members.length
          ? members.map((member) => member.name || member.email).join(", ")
          : "None"
      }`,
    ];
    const historyLines = conversationHistory
      .slice(-14)
      .map((item) => {
        const role =
          item?.role === "assistant" || item?.name === "Savy"
            ? "Savy"
            : item?.name || "User";
        return `${role}: ${String(item?.message || "").slice(0, 1200)}`;
      })
      .filter((line) => line.trim() && !line.endsWith(": "));

    const prompt = [
      "You are Savy, an intelligent task-aware AI assistant embedded in a task chat.",
      requesterIdentity,
      toneAndRoleInstruction,
      "CRITICAL MEMORY RULES:",
      "- You MUST read the Conversation History below. Do not ever say 'There is no previous conversation' if the history has messages.",
      "- Continue naturally from previous messages. Reference past discussion when helpful.",
      "- Do not act like this is a fresh conversation if history exists.",
      "CRITICAL IDENTITY RULES:",
      "- If the user says 'I am [Name]', acknowledge them by that name and confirm you will respond based on their assigned work.",
      "RESPONSE STYLE:",
      "- Provide short, direct, actionable, and meaningful answers in 2-4 sentences.",
      "- Be relevant to the task and avoid generic or repetitive filler.",
      "",
      "Task Context:",
      ...contextLines,
      "",
      "Conversation History:",
      ...(historyLines.length ? historyLines : ["(This is the start of the conversation. No prior messages exist.)"]),
      "",
      `Question from ${requesterName}: ${promptQuestion}`,
    ].join("\n");

    const raw = await callGemini(prompt, {
      maxRetries: 1,
      baseDelayMs: 2000,
      context: "task-assistant",
      lockKey: `task-assistant:${taskTitle}:${promptQuestion.slice(0, 32)}`,
    });

    const answer =
      String(raw || "").trim() ||
      "I can help clarify the task, but I need a more specific question.";

    return res.json({ answer });
  } catch (err) {
    console.error("Task assistant error:", err);
    recordAiFallback("geminiRoutes.task-assistant");
    return res.json({
      answer:
        "AI assistance is temporarily unavailable. Please retry in a moment.",
      fromFallback: true,
    });
  }
});

export default router;
