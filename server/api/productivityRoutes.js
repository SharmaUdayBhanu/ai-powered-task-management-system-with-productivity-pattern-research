import express from "express";
import { Employee } from "../models.js";
import {
  callGemini,
  safeParseJson,
  getRetryAfterMs,
  isGeminiRateLimited,
  getAiTelemetrySnapshot,
  recordAiFallback,
  hasAiClientConfig,
} from "./gemini/geminiClient.js";
import {
  buildAdminCompetitiveInsightsPrompt,
  buildEmployeeInsightsPrompt,
} from "./gemini/geminiPrompts.js";

const router = express.Router();

const CHART_WINDOW_DAYS = 14;
const AI_INSIGHTS_TTL_MS = 10 * 60 * 1000;
const ADMIN_INSIGHTS_TTL_MS = 10 * 60 * 1000;
const inFlightInsights = new Map();
const inFlightRankings = new Map();
const cooldownByKey = new Map();
const rankingsCache = new Map();

const isVisibleTask = (task) => Boolean(task) && !task.isDeleted && !task.notAccepted;

const getVisibleTasks = (tasks = []) =>
  Array.isArray(tasks) ? tasks.filter(isVisibleTask) : [];

const classifyTrend = ({
  trendDelta = 0,
  completed = 0,
  failed = 0,
  completionRate = 0,
}) => {
  const totalOutcomes = completed + failed;
  const failurePressure = totalOutcomes > 0 ? failed / totalOutcomes : 0;

  if (totalOutcomes < 2 && completed < 2) {
    return {
      label: "Stable",
      reason: "Low recent outcome volume; waiting for more signal.",
      confidence: "low",
    };
  }

  if (
    trendDelta >= 2 ||
    (trendDelta > 0 && completionRate >= 65 && failurePressure <= 0.4)
  ) {
    return {
      label: "Improving",
      reason: "Recent completion cadence is strengthening.",
      confidence: "medium",
    };
  }

  if (
    trendDelta <= -2 ||
    completionRate < 45 ||
    failurePressure >= 0.6
  ) {
    return {
      label: "Declining",
      reason: "Recent completion quality or volume is weakening.",
      confidence: "medium",
    };
  }

  return {
    label: "Stable",
    reason: "Recent output is holding near prior baseline.",
    confidence: "medium",
  };
};

const buildConsistencyReport = ({ dashboardSummary, allEmployees }) => {
  const totalsFromLeaderboard = (allEmployees || []).reduce(
    (acc, employee) => {
      acc.completed += Number(employee.totalCompleted) || 0;
      acc.failed += Number(employee.totalFailed) || 0;
      return acc;
    },
    { completed: 0, failed: 0 },
  );

  const completedMatch =
    totalsFromLeaderboard.completed === (dashboardSummary.completedTasks || 0);
  const failedMatch =
    totalsFromLeaderboard.failed === (dashboardSummary.failedTasks || 0);

  const ok = completedMatch && failedMatch;
  return {
    ok,
    checks: {
      completedMatch,
      failedMatch,
    },
    expected: {
      completed: dashboardSummary.completedTasks || 0,
      failed: dashboardSummary.failedTasks || 0,
    },
    actual: totalsFromLeaderboard,
    generatedAt: new Date().toISOString(),
  };
};

router.get("/monitoring", (req, res) => {
  return res.json({
    aiTelemetry: getAiTelemetrySnapshot(),
    inFlight: {
      employeeInsights: inFlightInsights.size,
      rankings: inFlightRankings.size,
    },
    cache: {
      rankingsEntries: rankingsCache.size,
      cooldownKeys: cooldownByKey.size,
    },
    generatedAt: new Date().toISOString(),
  });
});

const isFresh = (dateValue, ttlMs) => {
  if (!dateValue) return false;
  const ts = new Date(dateValue).getTime();
  if (Number.isNaN(ts)) return false;
  return Date.now() - ts < ttlMs;
};

const isValidDate = (value) => {
  const d = new Date(value);
  return !Number.isNaN(d.getTime());
};

const toDayKey = (date) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

const parseDayKey = (dayKey) => {
  const match = String(dayKey || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const parsed = new Date(year, month, day);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const formatDayLabel = (date) =>
  date.toLocaleDateString("en-US", { month: "short", day: "numeric" });

const getWindowStart = (days) => {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  return start;
};

const getTaskDeadline = (taskDate) => {
  if (!taskDate || !isValidDate(taskDate)) return null;
  const deadline = new Date(taskDate);
  // If only a date is provided, treat deadline as end-of-day instead of midnight.
  if (typeof taskDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(taskDate)) {
    deadline.setHours(23, 59, 59, 999);
  }
  return deadline;
};

const resolveOnTime = (task) => {
  const deadline = getTaskDeadline(task.taskDate);
  if (!deadline) return null;
  if (!task.completedAt) return null;
  return new Date(task.completedAt) <= deadline;
};

const resolveCompletionTimeMinutes = (task) => {
  if (typeof task.completionTime === "number" && task.completionTime >= 0) {
    return task.completionTime;
  }
  if (
    task.startedAt &&
    task.completedAt &&
    isValidDate(task.startedAt) &&
    isValidDate(task.completedAt)
  ) {
    return Math.max(
      0,
      Math.round(
        (new Date(task.completedAt) - new Date(task.startedAt)) / 60000,
      ),
    );
  }
  if (
    task.acceptedAt &&
    task.completedAt &&
    isValidDate(task.acceptedAt) &&
    isValidDate(task.completedAt)
  ) {
    return Math.max(
      0,
      Math.round(
        (new Date(task.completedAt) - new Date(task.acceptedAt)) / 60000,
      ),
    );
  }
  if (
    task.assignedAt &&
    task.completedAt &&
    isValidDate(task.assignedAt) &&
    isValidDate(task.completedAt)
  ) {
    return Math.max(
      0,
      Math.round(
        (new Date(task.completedAt) - new Date(task.assignedAt)) / 60000,
      ),
    );
  }
  if (
    typeof task.estimatedDuration === "number" &&
    task.estimatedDuration > 0
  ) {
    return task.estimatedDuration;
  }
  return null;
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

const applyTaskTimeouts = (tasks = []) => {
  const now = new Date();
  const nowMs = now.getTime();
  let changed = false;

  const updatedTasks = tasks.map((task) => {
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
      isValidDate(nextTask.assignedAt) &&
      !nextTask.acceptanceDeadline
    ) {
      nextTask.acceptanceDeadline = new Date(
        new Date(nextTask.assignedAt).getTime() +
          nextTask.acceptanceTimeLimitMinutes * 60 * 1000,
      );
      changed = true;
    }

    const acceptanceDeadlineMs =
      nextTask.acceptanceDeadline && isValidDate(nextTask.acceptanceDeadline)
        ? new Date(nextTask.acceptanceDeadline).getTime()
        : getTaskDeadline(nextTask.taskDate)?.getTime() || null;

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

  return { changed, updatedTasks };
};

const normalizeEmployeeTaskTimeouts = async (employee) => {
  if (!employee) return employee;

  const { changed, updatedTasks } = applyTaskTimeouts(employee.tasks || []);
  if (!changed) return employee;

  const taskCounts = computeTaskCounts(updatedTasks);

  await Employee.findByIdAndUpdate(employee._id, {
    $set: {
      tasks: updatedTasks,
      taskCounts,
    },
  });

  employee.tasks = updatedTasks;
  employee.taskCounts = taskCounts;
  return employee;
};

const computeTaskFormulaMetrics = (tasks = []) => {
  const visibleTasks = getVisibleTasks(tasks);
  const totalTasks = visibleTasks.length;
  const completedTasks = visibleTasks.filter((t) => t.completed);
  const failedTasks = visibleTasks.filter((t) => t.failed);

  const completionRate =
    totalTasks > 0 ? (completedTasks.length / totalTasks) * 100 : 0;

  const productivityScore = completedTasks.length * 2 - failedTasks.length;

  const completionTimeSum = completedTasks.reduce((sum, task) => {
    const completionMinutes = resolveCompletionTimeMinutes(task);
    if (typeof completionMinutes === "number" && completionMinutes >= 0) {
      return sum + completionMinutes;
    }
    return sum;
  }, 0);

  const averageCompletionTimeMinutes =
    completedTasks.length > 0 ? completionTimeSum / completedTasks.length : 0;

  return {
    totalTasks,
    completedTasks: completedTasks.length,
    failedTasks: failedTasks.length,
    completionRate: Number(completionRate.toFixed(1)),
    productivityScore,
    averageCompletionTimeMinutes: Number(
      averageCompletionTimeMinutes.toFixed(1),
    ),
  };
};

const toStatusLabel = (task) => {
  if (task.completed) return "completed";
  if (task.failed) return "failed";
  if (task.active) return "active";
  if (task.newTask) return "new";
  return "other";
};

const getActivityTimestamp = (task) => {
  const source =
    task.completedAt ||
    task.updatedAt ||
    task.startedAt ||
    task.acceptedAt ||
    task.assignedAt ||
    task.createdAt ||
    task.taskDate;

  if (!source || !isValidDate(source)) return null;
  return new Date(source);
};

const buildRecentActivity = (tasks = [], limit = 5) => {
  return getVisibleTasks(tasks)
    .map((task) => {
      const activityAt = getActivityTimestamp(task);
      return {
        taskTitle: task.taskTitle,
        status: toStatusLabel(task),
        category: task.category || "General",
        activityAt: activityAt ? activityAt.toISOString() : null,
      };
    })
    .sort((a, b) => {
      const aTs = a.activityAt ? new Date(a.activityAt).getTime() : 0;
      const bTs = b.activityAt ? new Date(b.activityAt).getTime() : 0;
      return bTs - aTs;
    })
    .slice(0, limit);
};

const buildCompletionTimeSamples = (tasks = [], limit = 6) => {
  return getVisibleTasks(tasks)
    .filter((task) => task.completed)
    .map((task) => ({
      taskTitle: task.taskTitle,
      completionTimeMinutes: resolveCompletionTimeMinutes(task),
      completedAt:
        task.completedAt && isValidDate(task.completedAt)
          ? new Date(task.completedAt).toISOString()
          : null,
    }))
    .filter(
      (item) =>
        typeof item.completionTimeMinutes === "number" &&
        item.completionTimeMinutes >= 0,
    )
    .sort((a, b) => {
      const aTs = a.completedAt ? new Date(a.completedAt).getTime() : 0;
      const bTs = b.completedAt ? new Date(b.completedAt).getTime() : 0;
      return bTs - aTs;
    })
    .slice(0, limit);
};

const normalizeInsightsList = (raw, max = 5) => {
  const source = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.insights)
      ? raw.insights
      : [];

  const deduped = [];
  for (const item of source) {
    const normalized = String(item || "").trim();
    if (!normalized) continue;
    if (!deduped.includes(normalized)) deduped.push(normalized);
    if (deduped.length >= max) break;
  }
  return deduped;
};

const normalizeEmployeeAiAnalysis = (raw) => {
  if (!raw || typeof raw !== "object") return null;

  const insights = normalizeInsightsList(raw, 5);
  const pattern = String(raw.pattern || "").trim();
  const specialization = String(raw.specialization || "").trim();
  const consistency = String(raw.consistency || "").trim();
  const comparativeSignal = String(raw.comparativeSignal || "").trim();
  const riskSignals = Array.isArray(raw.riskSignals)
    ? raw.riskSignals
        .map((item) => String(item || "").trim())
        .filter(Boolean)
        .slice(0, 3)
    : [];

  const changeDetectionRaw =
    raw.changeDetection && typeof raw.changeDetection === "object"
      ? raw.changeDetection
      : {};
  const changeStatus = String(changeDetectionRaw.status || "").trim();
  const changeReason = String(changeDetectionRaw.reason || "").trim();

  return {
    insights,
    pattern,
    specialization,
    consistency,
    comparativeSignal,
    riskSignals,
    changeDetection: {
      status: changeStatus,
      reason: changeReason,
    },
  };
};

const normalizeAdminInsights = (raw) => {
  if (!raw || typeof raw !== "object") return null;

  const summary = String(raw.summary || "").trim();
  const topPerformer = String(raw.topPerformer || "").trim();
  const mostImproved = String(raw.mostImproved || "").trim();

  const recommendations = Array.isArray(raw.recommendations)
    ? raw.recommendations
        .map((item) => String(item || "").trim())
        .filter(Boolean)
        .slice(0, 5)
    : [];

  const teamPattern = String(raw.teamPattern || "").trim();
  const workloadImbalance = String(raw.workloadImbalance || "").trim();
  const failureClusters = String(raw.failureClusters || "").trim();
  const underutilizedEmployees = Array.isArray(raw.underutilizedEmployees)
    ? raw.underutilizedEmployees
        .map((item) => String(item || "").trim())
        .filter(Boolean)
        .slice(0, 5)
    : [];
  const changeSignals = Array.isArray(raw.changeSignals)
    ? raw.changeSignals
        .map((item) => String(item || "").trim())
        .filter(Boolean)
        .slice(0, 5)
    : [];

  const employeeInsights = Array.isArray(raw.employeeInsights)
    ? raw.employeeInsights
        .map((item) => ({
          name: String(item?.name || "").trim(),
          email: String(item?.email || "").trim(),
          pattern: String(item?.pattern || "").trim(),
          specialization: String(item?.specialization || "").trim(),
          riskSignal: String(item?.riskSignal || "").trim(),
          changeSignal: String(item?.changeSignal || "").trim(),
        }))
        .filter((item) => item.name || item.email)
        .slice(0, 12)
    : [];

  const expertAreasInput =
    raw.expertAreas && typeof raw.expertAreas === "object"
      ? raw.expertAreas
      : {};
  const expertAreas = Object.fromEntries(
    Object.entries(expertAreasInput)
      .map(([name, area]) => [
        String(name || "").trim(),
        String(area || "").trim(),
      ])
      .filter(([name, area]) => Boolean(name && area)),
  );

  if (!summary || recommendations.length === 0) return null;

  return {
    summary,
    topPerformer,
    mostImproved,
    teamPattern,
    workloadImbalance,
    failureClusters,
    underutilizedEmployees,
    changeSignals,
    employeeInsights,
    expertAreas,
    recommendations,
  };
};

const buildEmployeeInsightsInput = ({
  employee,
  stats,
  teamBaseline,
  action,
  taskTitle,
  taskDescription,
  taskStatus,
}) => {
  const tasks = employee?.tasks || [];
  const formulaMetrics = computeTaskFormulaMetrics(tasks);
  const taskCounts = computeTaskCounts(tasks);

  return {
    employee: {
      id: employee?._id?.toString?.() || null,
      name: employee?.firstName || "Employee",
      email: employee?.email || null,
    },
    metrics: {
      totalTasks: formulaMetrics.totalTasks,
      completedTasks: formulaMetrics.completedTasks,
      failedTasks: formulaMetrics.failedTasks,
      completionRate: formulaMetrics.completionRate,
      productivityScore: formulaMetrics.productivityScore,
      averageCompletionTimeMinutes: formulaMetrics.averageCompletionTimeMinutes,
      onTimePercent: stats.onTimePercent,
      delayedPercent: stats.delayedPercent,
      completedLast7Days: stats.completedLast7Days,
      completedPrevious7Days: stats.completedPrevious7Days,
      productivityTrendDelta: stats.productivityTrendDelta,
      peakProductivityWindow: stats.peakProductivityWindow,
    },
    taskCounts,
    completionTimes: {
      averageCompletionTimeMinutes: formulaMetrics.averageCompletionTimeMinutes,
      samples: buildCompletionTimeSamples(tasks),
    },
    teamBaseline: teamBaseline || null,
    recentActivity: buildRecentActivity(tasks),
    recentAction:
      action && taskStatus
        ? {
            action,
            taskTitle: taskTitle || null,
            taskDescriptionPreview: taskDescription
              ? String(taskDescription).slice(0, 140)
              : null,
            taskStatus,
          }
        : null,
  };
};

const computeTeamBaselineSnapshot = (employees = [], currentEmployeeId) => {
  const peers = (employees || []).filter(
    (employee) =>
      String(employee?._id || "") !== String(currentEmployeeId || ""),
  );

  if (!peers.length) {
    return {
      peerCount: 0,
      avgOnTimePercent: 0,
      avgCompletionMinutes: 0,
      avgCompletedLast7: 0,
      avgProductivityScore: 0,
    };
  }

  const summary = peers.reduce(
    (acc, peer) => {
      const peerStats = computeStats(peer);
      acc.onTime += Number(peerStats.onTimePercent) || 0;
      acc.completion += Number(peerStats.averageCompletionTimeMinutes) || 0;
      acc.completedLast7 += Number(peerStats.completedLast7Days) || 0;
      acc.score += Number(peerStats.productivityScore) || 0;
      return acc;
    },
    { onTime: 0, completion: 0, completedLast7: 0, score: 0 },
  );

  return {
    peerCount: peers.length,
    avgOnTimePercent: Number((summary.onTime / peers.length).toFixed(1)),
    avgCompletionMinutes: Number(
      (summary.completion / peers.length).toFixed(1),
    ),
    avgCompletedLast7: Number(
      (summary.completedLast7 / peers.length).toFixed(1),
    ),
    avgProductivityScore: Number((summary.score / peers.length).toFixed(1)),
  };
};

const generateDataDrivenInsights = (input) => {
  const insights = [];
  const metrics = input?.metrics || {};
  const taskCounts = input?.taskCounts || {};

  insights.push(
    `Completion rate is ${metrics.completionRate ?? 0}% across ${metrics.totalTasks ?? 0} tasks (${metrics.completedTasks ?? 0} completed, ${metrics.failedTasks ?? 0} failed).`,
  );

  insights.push(
    `Productivity score is ${metrics.productivityScore ?? 0} using score = (completed × 2) − failed, with average completion time ${metrics.averageCompletionTimeMinutes ?? 0} minutes.`,
  );

  if (typeof metrics.productivityTrendDelta === "number") {
    const trendLabel =
      metrics.productivityTrendDelta > 0
        ? `improving by ${metrics.productivityTrendDelta} tasks compared to the previous 7-day window`
        : metrics.productivityTrendDelta < 0
          ? `declining by ${Math.abs(metrics.productivityTrendDelta)} tasks compared to the previous 7-day window`
          : "stable compared to the previous 7-day window";
    insights.push(
      `Weekly completion trend is ${trendLabel} (${metrics.completedLast7Days ?? 0} vs ${metrics.completedPrevious7Days ?? 0}).`,
    );
  }

  if (taskCounts.active > 0 || taskCounts.newTask > 0) {
    insights.push(
      `Current workload has ${taskCounts.active || 0} active and ${taskCounts.newTask || 0} new tasks; prioritize high-impact items before opening additional tasks.`,
    );
  }

  if (input?.recentAction?.taskTitle && input?.recentAction?.taskStatus) {
    insights.push(
      `Latest action: "${input.recentAction.taskTitle}" is marked ${input.recentAction.taskStatus}; use this as the immediate checkpoint for next-step planning.`,
    );
  }

  return normalizeInsightsList(insights, 5);
};

const contradictsCoreMetrics = (line, metrics = {}) => {
  const text = String(line || "").toLowerCase();
  if (!text) return false;

  const completedTasks = Number(metrics.completedTasks) || 0;
  const totalTasks = Number(metrics.totalTasks) || 0;
  const failedTasks = Number(metrics.failedTasks) || 0;

  if (
    completedTasks > 0 &&
    /(no\s+tasks?\s+completed|no\s+completion|hasn'?t\s+completed\s+any\s+tasks?)/i.test(
      text,
    )
  ) {
    return true;
  }

  if (
    totalTasks > 0 &&
    /(no\s+tasks?\s+assigned|no\s+tasks?\s+available)/i.test(text)
  ) {
    return true;
  }

  if (
    failedTasks === 0 &&
    /(high\s+failure|many\s+failed|frequent\s+failure)/i.test(text)
  ) {
    return true;
  }

  return false;
};

const mergeWithAuthoritativeInsights = (input, aiInsights = []) => {
  const authoritative = generateDataDrivenInsights(input);
  const filteredAi = normalizeInsightsList(aiInsights, 5).filter(
    (line) => !contradictsCoreMetrics(line, input?.metrics || {}),
  );
  return normalizeInsightsList([...authoritative, ...filteredAi], 5);
};

const buildEmployeePatternFallback = (input) => {
  const metrics = input?.metrics || {};
  const completionRate = Number(metrics.completionRate) || 0;
  const onTimePercent = Number(metrics.onTimePercent) || 0;
  const failedTasks = Number(metrics.failedTasks) || 0;
  const completedTasks = Number(metrics.completedTasks) || 0;
  const avgCompletion = Number(metrics.averageCompletionTimeMinutes) || 0;
  const trendDelta = Number(metrics.productivityTrendDelta) || 0;
  const totalTasks = Number(metrics.totalTasks) || 0;
  const peakWindow = String(metrics.peakProductivityWindow || "N/A");
  const activeTasks = Number(input?.taskCounts?.active) || 0;
  const newTasks = Number(input?.taskCounts?.newTask) || 0;

  let pattern =
    "Balanced execution profile with moderate throughput and predictable delivery.";
  if (avgCompletion > 0 && avgCompletion <= 55 && failedTasks >= 2) {
    pattern =
      "Fast execution profile with elevated rework exposure when workload density increases.";
  } else if (avgCompletion >= 90 && onTimePercent >= 75) {
    pattern =
      "Deliberate but reliable execution profile that favors accuracy over speed.";
  } else if (completionRate >= 70 && onTimePercent >= 80) {
    pattern =
      "Consistency-driven delivery profile with stable on-time behavior across tasks.";
  }

  let specialization = "General execution support";
  if (/\d{2}:00/.test(peakWindow) && onTimePercent >= 80) {
    specialization =
      "Consistency-based delivery roles and deadline-sensitive execution";
  }
  if (avgCompletion > 0 && avgCompletion <= 60 && completionRate >= 65) {
    specialization =
      "Execution-focused operational work with short task cycles";
  }
  if (avgCompletion >= 85 && failedTasks <= Math.max(1, completedTasks * 0.2)) {
    specialization =
      "Analytical or quality-sensitive work requiring deeper processing";
  }

  let consistency = "moderate consistency with mixed cycle stability";
  if (onTimePercent >= 85 && completionRate >= 70) {
    consistency = "high consistency with dependable completion behavior";
  } else if (onTimePercent < 55 || failedTasks > completedTasks * 0.6) {
    consistency = "low consistency with volatile outcomes";
  }

  const riskSignals = [];
  if (failedTasks >= 3) {
    riskSignals.push(
      "Failure frequency is elevated relative to completed output.",
    );
  }
  if (activeTasks + newTasks >= 8) {
    riskSignals.push("Open workload is high, increasing context-switch risk.");
  }
  if (totalTasks > 0 && completedTasks === 0) {
    riskSignals.push(
      "No completion evidence in current window; inactivity risk detected.",
    );
  }
  if (!riskSignals.length) {
    riskSignals.push("No critical risk cluster detected in current snapshot.");
  }

  const changeDetection =
    trendDelta > 0
      ? {
          status: "improving",
          reason: `Recent completions increased by ${trendDelta} compared to the prior 7-day window.`,
        }
      : trendDelta < 0
        ? {
            status: "declining",
            reason: `Recent completions dropped by ${Math.abs(trendDelta)} versus the prior 7-day window.`,
          }
        : {
            status: "stable",
            reason:
              "Recent completion volume is flat against the prior 7-day window.",
          };

  const comparativeSignal =
    completedTasks >= 6
      ? "Above baseline throughput pattern with sustained completion cadence."
      : failedTasks >= 3
        ? "Outcome reliability is below baseline due to clustered failures."
        : "Performance signal sits near team baseline with no extreme variance.";

  return {
    insights: generateDataDrivenInsights(input),
    pattern,
    specialization,
    consistency,
    riskSignals,
    changeDetection,
    comparativeSignal,
  };
};

const hasRecentOutcomeSince = (tasks = [], lastInsightUpdate) => {
  if (!Array.isArray(tasks) || tasks.length === 0) return false;
  const lastInsightTs = new Date(lastInsightUpdate).getTime();
  if (Number.isNaN(lastInsightTs)) return true;

  return tasks.some((task) => {
    if (!task?.completed && !task?.failed) return false;
    if (!task?.completedAt || !isValidDate(task.completedAt)) return true;
    return new Date(task.completedAt).getTime() > lastInsightTs;
  });
};

const buildLowDataEmployeeAnalysis = (input) => {
  const metrics = input?.metrics || {};
  const completedTasks = Number(metrics.completedTasks) || 0;
  const totalTasks = Number(metrics.totalTasks) || 0;
  const completedLast7 = Number(metrics.completedLast7Days) || 0;

  const cautiousInsights = [];
  if (completedTasks > 0) {
    cautiousInsights.push(
      `Recent activity detected: ${completedTasks} completed task${completedTasks > 1 ? "s" : ""}${completedLast7 ? ` (${completedLast7} in last 7 days)` : ""}.`,
    );
  } else {
    cautiousInsights.push(
      "Very limited completion history is available; insights will become stronger after more completed tasks.",
    );
  }

  if (totalTasks <= 1) {
    cautiousInsights.push(
      "Data is too sparse for strong pattern claims; treat this as an initial baseline snapshot.",
    );
  } else {
    cautiousInsights.push(
      "Early signal only: avoid overfitting conclusions until more task outcomes are recorded.",
    );
  }

  return {
    insights: normalizeInsightsList(cautiousInsights, 5),
    pattern:
      "Insufficient historical data for a stable execution pattern; baseline capture in progress.",
    specialization:
      "Not enough completed volume yet to infer specialization reliably.",
    consistency: "low-confidence (insufficient completed-task sample)",
    riskSignals: [
      "Low sample size can distort trend, specialization, and risk interpretation.",
    ],
    changeDetection: {
      status: "stable",
      reason:
        "Insufficient week-over-week volume to classify meaningful directional change.",
    },
    comparativeSignal:
      "Comparative signal is low-confidence until a larger completion history is available.",
  };
};

const generateAdminDataDrivenInsights = ({
  dashboardSummary,
  allEmployees,
}) => {
  if (!Array.isArray(allEmployees) || allEmployees.length === 0) {
    return null;
  }

  const topPerformer = allEmployees[0];
  const mostImproved = [...allEmployees].sort(
    (a, b) => b.trendDelta - a.trendDelta,
  )[0];

  const expertAreas = {};
  allEmployees.slice(0, 3).forEach((emp) => {
    const strength =
      emp.onTimePercent >= 80
        ? `high schedule reliability (${emp.onTimePercent.toFixed(1)}% on-time)`
        : emp.avgCompletion <= dashboardSummary.averageCompletionTimeMinutes
          ? `fast cycle time (${emp.avgCompletion} min average)`
          : `consistent output (${emp.completedLast7} completions in last 7 days)`;
    expertAreas[emp.name] = strength;
  });

  const overloaded = allEmployees
    .filter((emp) => emp.completedLast7 <= 1 && emp.totalFailed >= 2)
    .map((emp) => emp.name);
  const underutilized = allEmployees
    .filter((emp) => emp.completedLast7 === 0 && emp.totalFailed === 0)
    .map((emp) => `${emp.name} (low recent utilization)`);
  const failureClusterEmployees = allEmployees
    .filter((emp) => emp.totalFailed >= Math.max(2, emp.totalCompleted * 0.5))
    .map((emp) => emp.name);

  const teamPattern =
    dashboardSummary.completionRate >= 70
      ? "Team is operating with completion-led momentum, but output concentration around top performers should be monitored."
      : "Team is operating in a recovery pattern with completion instability and higher delivery variance.";

  const workloadImbalance = overloaded.length
    ? `Potential workload imbalance around ${overloaded.join(", ")}; review assignment mix and checkpoint frequency.`
    : "No severe imbalance detected; workload appears relatively distributed across current contributors.";

  const failureClusters = failureClusterEmployees.length
    ? `Failure outcomes are clustering around ${failureClusterEmployees.join(", ")}, suggesting execution-risk concentration.`
    : "No strong failure cluster detected in current team snapshot.";

  const changeSignals = allEmployees.slice(0, 5).map((emp) => {
    const completionRateFromOutcomes =
      emp.totalCompleted + emp.totalFailed > 0
        ? (emp.totalCompleted / (emp.totalCompleted + emp.totalFailed)) * 100
        : 0;
    const trend = classifyTrend({
      trendDelta: emp.trendDelta,
      completed: emp.totalCompleted,
      failed: emp.totalFailed,
      completionRate: completionRateFromOutcomes,
    });
    return `${emp.name} ${trend.label.toLowerCase()} (${emp.trendDelta >= 0 ? "+" : ""}${emp.trendDelta} delta): ${trend.reason}`;
  });

  const employeeInsights = allEmployees.slice(0, 8).map((emp) => {
    const outcomes = Number(emp.totalCompleted || 0) + Number(emp.totalFailed || 0);
    const completionRateFromOutcomes =
      outcomes > 0 ? (Number(emp.totalCompleted || 0) / outcomes) * 100 : 0;
    const trend = classifyTrend({
      trendDelta: emp.trendDelta,
      completed: Number(emp.totalCompleted || 0),
      failed: Number(emp.totalFailed || 0),
      completionRate: completionRateFromOutcomes,
    });
    const lowData = outcomes < 3;

    const pattern =
      lowData
        ? "early-stage signal (insufficient historical outcomes)"
        : emp.avgCompletion <= dashboardSummary.averageCompletionTimeMinutes
        ? "faster execution profile"
        : "deliberate execution profile";
    const specialization =
      lowData
        ? "specialization not yet inferable"
        : emp.onTimePercent >= 80
        ? "deadline-sensitive delivery"
        : emp.avgCompletion <= dashboardSummary.averageCompletionTimeMinutes
          ? "execution-focused short-cycle tasks"
          : "quality-oriented analytical tasks";
    const riskSignal =
      lowData
        ? "low confidence signal due to small sample size"
        : emp.totalFailed >= Math.max(2, emp.totalCompleted * 0.5)
        ? "failure density is elevated"
        : "no critical risk cluster";
    const changeSignal = `${trend.label} (${emp.trendDelta >= 0 ? "+" : ""}${emp.trendDelta})`;

    return {
      name: emp.name,
      email: emp.email || "",
      pattern,
      specialization,
      riskSignal,
      changeSignal,
    };
  });

  return {
    summary: `Team completion rate is ${dashboardSummary.completionRate}% across ${dashboardSummary.totalTasks} tasks. ${topPerformer.name} currently leads with score ${topPerformer.productivityScore}, while trend monitoring should focus on employees with negative weekly deltas.`,
    topPerformer: `${topPerformer.name} leads with score ${topPerformer.productivityScore} and ${topPerformer.onTimePercent.toFixed(1)}% on-time delivery.`,
    mostImproved: `${mostImproved.name} shows the strongest recent trend delta (${mostImproved.trendDelta >= 0 ? "+" : ""}${mostImproved.trendDelta}).`,
    teamPattern,
    workloadImbalance,
    failureClusters,
    underutilizedEmployees: underutilized,
    changeSignals,
    employeeInsights,
    expertAreas,
    recommendations: [
      `Route higher-priority work to employees with on-time rate above ${Math.max(70, Math.round(topPerformer.onTimePercent - 5))}%.`,
      `Coach employees with negative trend deltas using recent failed-task reviews and shorter milestone check-ins.`,
      `Use completion-time outliers to rebalance workload and protect team average completion time (${dashboardSummary.averageCompletionTimeMinutes} min).`,
    ],
  };
};

const reconcileAdminInsights = ({ candidate, dashboardSummary, allEmployees }) => {
  const authoritative = generateAdminDataDrivenInsights({
    dashboardSummary,
    allEmployees,
  });

  if (!authoritative) return null;
  if (!candidate) return authoritative;

  return {
    ...candidate,
    summary: authoritative.summary,
    topPerformer: authoritative.topPerformer,
    mostImproved: authoritative.mostImproved,
    teamPattern: authoritative.teamPattern,
    workloadImbalance: authoritative.workloadImbalance,
    failureClusters: authoritative.failureClusters,
    underutilizedEmployees: authoritative.underutilizedEmployees,
    changeSignals: authoritative.changeSignals,
    employeeInsights: authoritative.employeeInsights,
    expertAreas:
      Object.keys(authoritative.expertAreas || {}).length > 0
        ? authoritative.expertAreas
        : candidate.expertAreas || {},
    recommendations: normalizeInsightsList(
      [
        ...(Array.isArray(candidate.recommendations)
          ? candidate.recommendations
          : []),
        ...(Array.isArray(authoritative.recommendations)
          ? authoritative.recommendations
          : []),
      ],
      5,
    ),
  };
};

const buildAdminInsightsSignature = ({ dashboardSummary, allEmployees }) =>
  JSON.stringify({
    dashboardSummary,
    allEmployees,
  });

function computeStats(employee) {
  const tasks = getVisibleTasks(employee.tasks || []);

  const formulaMetrics = computeTaskFormulaMetrics(tasks);

  const completedTasks = tasks.filter((t) => t.completed);
  const completedTasksWithTimestamp = completedTasks.filter(
    (t) => t.completedAt && isValidDate(t.completedAt),
  );
  const activeTasks = tasks.filter((t) => t.active);
  const failedTasks = tasks.filter((t) => t.failed);

  // On-time vs delayed (only for tasks where this can be derived)
  let onTimeCount = 0;
  let delayedCount = 0;
  completedTasksWithTimestamp.forEach((t) => {
    const isOnTime = resolveOnTime(t);
    if (isOnTime === true) onTimeCount += 1;
    else if (isOnTime === false) delayedCount += 1;
  });
  const totalTimedCompleted = onTimeCount + delayedCount;
  const onTimePercent =
    totalTimedCompleted > 0 ? (onTimeCount / totalTimedCompleted) * 100 : 0;
  const delayedPercent =
    totalTimedCompleted > 0 ? (delayedCount / totalTimedCompleted) * 100 : 0;

  // 14-day dense tasks-per-day + peak productivity hours
  const tasksPerDay = {};
  const windowStart = getWindowStart(CHART_WINDOW_DAYS);
  for (let i = 0; i < CHART_WINDOW_DAYS; i++) {
    const d = new Date(windowStart);
    d.setDate(windowStart.getDate() + i);
    tasksPerDay[toDayKey(d)] = 0;
  }

  const hourlyBuckets = new Array(24).fill(0);

  completedTasksWithTimestamp.forEach((t) => {
    const d = new Date(t.completedAt);
    if (d >= windowStart) {
      const dayKey = toDayKey(d);
      if (dayKey in tasksPerDay) {
        tasksPerDay[dayKey] += 1;
      }
    }
    const hour = d.getHours();
    hourlyBuckets[hour] += 1;
  });

  let peakHourStart = null;
  let peakCount = 0;
  for (let h = 0; h < 24; h++) {
    if (hourlyBuckets[h] > peakCount) {
      peakCount = hourlyBuckets[h];
      peakHourStart = h;
    }
  }
  const peakWindow =
    peakHourStart !== null
      ? `${String(peakHourStart).padStart(2, "0")}:00 - ${String((peakHourStart + 1) % 24).padStart(2, "0")}:00`
      : "N/A";

  // Simple productivity trend: compare last 7 days vs previous 7 days
  const today = new Date();
  const dayMs = 24 * 60 * 60 * 1000;
  const last7Start = new Date(today.getTime() - 7 * dayMs);
  const prev7Start = new Date(today.getTime() - 14 * dayMs);

  let last7 = 0;
  let prev7 = 0;
  completedTasksWithTimestamp.forEach((t) => {
    if (!t.completedAt) return;
    const d = new Date(t.completedAt);
    if (d >= last7Start && d <= today) last7 += 1;
    else if (d >= prev7Start && d < last7Start) prev7 += 1;
  });

  const trendDelta = last7 - prev7;
  const outcomeCompletionRate =
    completedTasks.length + failedTasks.length > 0
      ? (completedTasks.length / (completedTasks.length + failedTasks.length)) *
        100
      : 0;
  const trendMeta = classifyTrend({
    trendDelta,
    completed: completedTasks.length,
    failed: failedTasks.length,
    completionRate: outcomeCompletionRate,
  });

  return {
    totalTaskCount: formulaMetrics.totalTasks,
    completionRate: formulaMetrics.completionRate,
    productivityScore: formulaMetrics.productivityScore,
    averageCompletionTimeMinutes: formulaMetrics.averageCompletionTimeMinutes,
    onTimePercent: Number(onTimePercent.toFixed(1)),
    delayedPercent: Number(delayedPercent.toFixed(1)),
    tasksPerDay,
    peakProductivityWindow: peakWindow,
    completedLast7Days: last7,
    completedPrevious7Days: prev7,
    productivityTrendDelta: trendDelta,
    completedTaskCount: completedTasks.length,
    activeTaskCount: activeTasks.length,
    failedTaskCount: failedTasks.length,
    outcomeCompletionRate: Number(outcomeCompletionRate.toFixed(1)),
    trendLabel: trendMeta.label,
    trendReason: trendMeta.reason,
    trendConfidence: trendMeta.confidence,
  };
}

// GET /api/productivity/:employeeId/stats
router.get("/rankings", async (req, res) => {
  try {
    const forceRefresh = req.query.force === "true";
    const includeAI = req.query.includeAI !== "false";
    let employees = await Employee.find();
    employees = await Promise.all(
      employees.map((employee) => normalizeEmployeeTaskTimeouts(employee)),
    );

    const allTasks = employees.flatMap((employee) =>
      getVisibleTasks(employee.tasks || []),
    );
    const dashboardSummary = computeTaskFormulaMetrics(allTasks);

    if (!employees.length) {
      return res.json({
        leaderboard: [],
        summary: dashboardSummary,
        aiInsights: null,
        aiStatus: "no-data",
        insightEngine: "rules",
        cached: false,
      });
    }

    const leaderboard = employees.map((employee) => {
      const stats = computeStats(employee);

      return {
        employeeId: employee._id,
        name: employee.firstName,
        email: employee.email,
        stats,
        productivityScore: stats.productivityScore,
      };
    });

    const sorted = leaderboard.sort(
      (a, b) => b.productivityScore - a.productivityScore,
    );

    let aiInsights = null;
    let aiStatus = "skipped";
    let insightEngine = "rules";
    let cached = false;
    const allEmployees = sorted.map((entry) => ({
      name: entry.name,
      email: entry.email,
      avgCompletion: entry.stats.averageCompletionTimeMinutes,
      onTimePercent: entry.stats.onTimePercent,
      completedLast7: entry.stats.completedLast7Days,
      trendDelta: entry.stats.productivityTrendDelta,
      productivityScore: entry.productivityScore,
      totalCompleted: entry.stats.completedTaskCount,
      totalFailed: entry.stats.failedTaskCount,
    }));

    const aiLeaderboardSnapshot = sorted.slice(0, 8).map((entry) => ({
      name: entry.name,
      email: entry.email,
      productivityScore: entry.productivityScore,
      completedLast7: entry.stats.completedLast7Days,
      trendDelta: entry.stats.productivityTrendDelta,
      onTimePercent: entry.stats.onTimePercent,
      avgCompletion: entry.stats.averageCompletionTimeMinutes,
    }));

    const adminInsightsInput = {
      generatedAt: new Date().toISOString(),
      dashboardSummary: {
        totalTasks: dashboardSummary.totalTasks,
        completedTasks: dashboardSummary.completedTasks,
        failedTasks: dashboardSummary.failedTasks,
        completionRate: dashboardSummary.completionRate,
        productivityScore: dashboardSummary.productivityScore,
        averageCompletionTimeMinutes:
          dashboardSummary.averageCompletionTimeMinutes,
      },
      employeeCount: sorted.length,
      leaderboardSnapshot: aiLeaderboardSnapshot,
    };
    const consistency = buildConsistencyReport({
      dashboardSummary,
      allEmployees,
    });
    if (!consistency.ok) {
      console.warn(
        "[Productivity][Consistency] Rankings mismatch detected",
        consistency,
      );
    }
    const currentInsightsSignature = buildAdminInsightsSignature({
      dashboardSummary,
      allEmployees,
    });

    const rankingsKey = "admin-rankings-ai";
    const cooldownUntil = cooldownByKey.get(rankingsKey) || 0;
    const cachedRankings = rankingsCache.get(rankingsKey);

    if (
      cachedRankings?.aiInsights &&
      cachedRankings.signature === currentInsightsSignature &&
      !forceRefresh
    ) {
      aiInsights = cachedRankings.aiInsights;
      aiStatus = "cached";
      insightEngine = cachedRankings.insightEngine || "cached";
      cached = true;
    }

    if (!includeAI) {
      if (!aiInsights) {
        aiInsights = reconcileAdminInsights({
          candidate: null,
          dashboardSummary,
          allEmployees,
        });
        aiStatus = "skipped";
        insightEngine = "rules";
      }

      return res.json({
        leaderboard: sorted,
        summary: dashboardSummary,
        aiInsights,
        aiStatus,
        insightEngine,
        cached,
      });
    }

    if (
      !forceRefresh &&
      cachedRankings &&
      isFresh(cachedRankings.updatedAt, ADMIN_INSIGHTS_TTL_MS) &&
      !aiInsights
    ) {
      aiInsights = cachedRankings.aiInsights;
      aiStatus = cachedRankings.aiStatus || "ready";
      insightEngine = cachedRankings.insightEngine || "rules";
      cached = true;
    }

    if (
      !aiInsights &&
      hasAiClientConfig() &&
      allEmployees.length &&
      Date.now() >= cooldownUntil
    ) {
      try {
        const prompt = buildAdminCompetitiveInsightsPrompt({
          input: adminInsightsInput,
        });

        const computeRankingsInsights = async () => {
          const raw = await callGemini(prompt, {
            maxRetries: 1,
            baseDelayMs: 2000,
            context: "productivity-rankings-admin-insights",
            lockKey: rankingsKey,
          });
          const normalized = normalizeAdminInsights(safeParseJson(raw, null));
          return reconcileAdminInsights({
            candidate: normalized,
            dashboardSummary,
            allEmployees,
          });
        };

        const inFlight = inFlightRankings.get(rankingsKey);
        if (inFlight) {
          aiInsights = await inFlight;
        } else {
          const promise = computeRankingsInsights().finally(() => {
            inFlightRankings.delete(rankingsKey);
          });
          inFlightRankings.set(rankingsKey, promise);
          aiInsights = await promise;
        }

        if (!aiInsights || typeof aiInsights !== "object") {
          aiInsights = reconcileAdminInsights({
            candidate: null,
            dashboardSummary,
            allEmployees,
          });
          recordAiFallback("productivityRoutes.rankings.invalid-ai-output");
          insightEngine = "rules";
          aiStatus = "fallback";
        } else {
          insightEngine = "ai";
          aiStatus = "ready";
        }

        rankingsCache.set(rankingsKey, {
          aiInsights,
          aiStatus,
          insightEngine,
          signature: currentInsightsSignature,
          updatedAt: new Date(),
        });
      } catch (err) {
        if (isGeminiRateLimited(err)) {
          cooldownByKey.set(rankingsKey, Date.now() + getRetryAfterMs(err));
          aiStatus = "retry";
        } else {
          aiStatus = "failed";
        }
        console.warn("Failed to build AI admin insights:", err.message);
        aiInsights = reconcileAdminInsights({
          candidate: null,
          dashboardSummary,
          allEmployees,
        });
        recordAiFallback("productivityRoutes.rankings.ai-call-failed");
        insightEngine = "rules";
        rankingsCache.set(rankingsKey, {
          aiInsights,
          aiStatus,
          insightEngine,
          signature: currentInsightsSignature,
          updatedAt: new Date(),
        });
      }
    }

    if (!aiInsights && cachedRankings?.aiInsights) {
      aiInsights = cachedRankings.aiInsights;
      aiStatus = "ready";
      insightEngine = cachedRankings.insightEngine || "rules";
      cached = true;
    }

    if (!aiInsights) {
      aiInsights = reconcileAdminInsights({
        candidate: null,
        dashboardSummary,
        allEmployees,
      });
      recordAiFallback("productivityRoutes.rankings.empty-insights");
      insightEngine = "rules";
    }

    return res.json({
      leaderboard: sorted,
      summary: dashboardSummary,
      consistency,
      aiInsights,
      aiStatus,
      insightEngine,
      cached,
    });
  } catch (err) {
    console.error("Productivity rankings error:", err.message);
    return res.status(500).json({ error: "Failed to compute rankings" });
  }
});

router.get("/:employeeId/stats", async (req, res) => {
  try {
    let employee = await Employee.findById(req.params.employeeId);
    if (!employee) {
      return res.status(404).json({ error: "Employee not found" });
    }
    employee = await normalizeEmployeeTaskTimeouts(employee);
    const stats = computeStats(employee);
    return res.json(stats);
  } catch (err) {
    console.error("Productivity stats error:", err.message);
    return res.status(500).json({ error: "Failed to compute stats" });
  }
});

// GET /api/productivity/:employeeId/chart-data
router.get("/:employeeId/chart-data", async (req, res) => {
  try {
    let employee = await Employee.findById(req.params.employeeId);
    if (!employee) {
      return res.status(404).json({ error: "Employee not found" });
    }
    employee = await normalizeEmployeeTaskTimeouts(employee);
    const stats = computeStats(employee);

    const tasksPerDayEntries = Object.entries(stats.tasksPerDay)
      .map(([date, count]) => {
        const parsedDate = parseDayKey(date);
        return {
          date,
          dateLabel: parsedDate ? formatDayLabel(parsedDate) : date,
          count,
        };
      })
      .sort((a, b) => {
        const aDate = parseDayKey(a.date);
        const bDate = parseDayKey(b.date);
        const aTs = aDate ? aDate.getTime() : 0;
        const bTs = bDate ? bDate.getTime() : 0;
        return aTs - bTs;
      });

    const windowStart = getWindowStart(CHART_WINDOW_DAYS);
    const allCompletionDots = getVisibleTasks(employee.tasks || [])
      .filter(
        (task) =>
          task.completed && task.completedAt && isValidDate(task.completedAt),
      )
      .map((task) => {
        const completedAt = new Date(task.completedAt);
        const completionTimeMinutes = resolveCompletionTimeMinutes(task);
        return {
          taskTitle: task.taskTitle,
          completedAtTs: completedAt.getTime(),
          dateLabel: formatDayLabel(completedAt),
          completionTimeMinutes,
        };
      })
      .filter((point) => typeof point.completionTimeMinutes === "number")
      .sort((a, b) => a.completedAtTs - b.completedAtTs);

    const inWindowDots = allCompletionDots.filter(
      (point) => point.completedAtTs >= windowStart.getTime(),
    );

    // If no recent dots are available, show the latest historical completed tasks
    // so the scatter chart never appears blank for older datasets.
    const completionDurationDots =
      inWindowDots.length > 0 ? inWindowDots : allCompletionDots.slice(-20);

    const chartData = {
      tasksPerDay: tasksPerDayEntries,
      completionDurationDots,
      averageCompletionTimeMinutes: stats.averageCompletionTimeMinutes,
      productivityTrendDelta: stats.productivityTrendDelta,
      windowDays: CHART_WINDOW_DAYS,
    };

    // Store chart data in database (atomic update to avoid version conflicts)
    await Employee.findByIdAndUpdate(employee._id, {
      $set: {
        storedChartData: chartData,
        lastChartUpdate: new Date(),
      },
    });

    return res.json(chartData);
  } catch (err) {
    console.error("Productivity chart-data error:", err.message);
    return res.status(500).json({ error: "Failed to compute chart-data" });
  }
});

// GET /api/productivity/:employeeId/insights
router.get("/:employeeId/insights", async (req, res) => {
  try {
    const { action, taskTitle, taskDescription, taskStatus } = req.query; // Get task action context
    const forceRefresh = req.query.force === "true";
    let employee = await Employee.findById(req.params.employeeId);
    if (!employee) {
      return res.status(404).json({ error: "Employee not found" });
    }
    employee = await normalizeEmployeeTaskTimeouts(employee);
    const stats = computeStats(employee);
    const allEmployees = await Employee.find({}, { tasks: 1 });
    const normalizedEmployees = await Promise.all(
      allEmployees.map((item) => normalizeEmployeeTaskTimeouts(item)),
    );
    const teamBaseline = computeTeamBaselineSnapshot(
      normalizedEmployees,
      employee._id,
    );
    const structuredInsightsInput = buildEmployeeInsightsInput({
      employee,
      stats,
      teamBaseline,
      action,
      taskTitle,
      taskDescription,
      taskStatus,
    });
    const fallbackAnalysis = buildEmployeePatternFallback(
      structuredInsightsInput,
    );
    const lowDataMode =
      Number(structuredInsightsInput?.metrics?.totalTasks || 0) < 3 ||
      Number(structuredInsightsInput?.metrics?.completedTasks || 0) < 2;
    const postOutcomeFreshnessRequired = hasRecentOutcomeSince(
      getVisibleTasks(employee.tasks || []),
      employee.lastInsightUpdate,
    );

    const hasActionContext = Boolean(action && taskStatus);
    const insightsKey = `employee-insights:${employee._id}`;
    const cooldownUntil = cooldownByKey.get(insightsKey) || 0;

    if (lowDataMode) {
      const lowDataAnalysis = buildLowDataEmployeeAnalysis(
        structuredInsightsInput,
      );
      return res.json({
        stats,
        insights: lowDataAnalysis.insights,
        analysis: lowDataAnalysis,
        aiStatus: "low-data",
        insightEngine: "rules",
        lowData: true,
      });
    }

    if (
      !forceRefresh &&
      !hasActionContext &&
      !postOutcomeFreshnessRequired &&
      Array.isArray(employee.storedInsights) &&
      employee.storedInsights.length > 0 &&
      isFresh(employee.lastInsightUpdate, AI_INSIGHTS_TTL_MS)
    ) {
      const mergedCachedInsights = mergeWithAuthoritativeInsights(
        structuredInsightsInput,
        employee.storedInsights,
      );
      return res.json({
        stats,
        insights: mergedCachedInsights,
        analysis: {
          ...fallbackAnalysis,
          insights: mergedCachedInsights,
        },
        cached: true,
        aiStatus: "cached",
        insightEngine: "cached",
      });
    }

    if (Date.now() < cooldownUntil) {
      const fallbackInsights = mergeWithAuthoritativeInsights(
        structuredInsightsInput,
        !forceRefresh &&
          !postOutcomeFreshnessRequired &&
          Array.isArray(employee.storedInsights) &&
          employee.storedInsights.length > 0
          ? employee.storedInsights
          : fallbackAnalysis.insights,
      );
      return res.json({
        stats,
        insights: fallbackInsights,
        analysis: {
          ...fallbackAnalysis,
          insights: fallbackInsights,
        },
        cached: true,
        rateLimited: true,
        aiStatus: "retry",
        insightEngine: "rules",
      });
    }

    // Generate AI-powered insights with dedupe/cooldown protection.
    let insights = [];
    let analysis = null;
    let aiStatus = "fallback";
    let insightEngine = "rules";
    if (hasAiClientConfig()) {
      try {
        const prompt = buildEmployeeInsightsPrompt({
          input: structuredInsightsInput,
        });

        const computeInsights = async () => {
          const raw = await callGemini(prompt, {
            maxRetries: 1,
            baseDelayMs: 2000,
            context: "productivity-employee-insights",
            lockKey: insightsKey,
          });
          return safeParseJson(raw, { insights: [] });
        };

        const inFlight = inFlightInsights.get(insightsKey);
        const parsed = inFlight
          ? await inFlight
          : await (() => {
              const promise = computeInsights().finally(() => {
                inFlightInsights.delete(insightsKey);
              });
              inFlightInsights.set(insightsKey, promise);
              return promise;
            })();

        const normalizedAnalysis = normalizeEmployeeAiAnalysis(parsed);
        if (normalizedAnalysis?.insights?.length) {
          const mergedInsights = mergeWithAuthoritativeInsights(
            structuredInsightsInput,
            normalizedAnalysis.insights,
          );
          analysis = {
            ...normalizedAnalysis,
            insights: mergedInsights,
          };
          insights = mergedInsights;
          aiStatus = "ready";
          insightEngine = "ai";
        } else {
          analysis = fallbackAnalysis;
          insights = fallbackAnalysis.insights;
          recordAiFallback(
            "productivityRoutes.employee-insights.invalid-ai-output",
          );
          aiStatus = "fallback";
          insightEngine = "rules";
        }

        // Store insights in database using atomic update to avoid version conflicts.
        await Employee.findByIdAndUpdate(employee._id, {
          $set: {
            storedInsights: insights,
            lastInsightUpdate: new Date(),
          },
        });
      } catch (err) {
        if (isGeminiRateLimited(err)) {
          cooldownByKey.set(insightsKey, Date.now() + getRetryAfterMs(err));
          aiStatus = "retry";
        } else {
          aiStatus = "failed";
        }
        console.warn(
          "AI insights generation failed, using fallback:",
          err.message,
        );
        const fallbackInsights = mergeWithAuthoritativeInsights(
          structuredInsightsInput,
          Array.isArray(employee.storedInsights) &&
            employee.storedInsights.length > 0
            ? employee.storedInsights
            : fallbackAnalysis.insights,
        );
        insights = fallbackInsights;
        analysis = {
          ...fallbackAnalysis,
          insights: fallbackInsights,
        };
        recordAiFallback("productivityRoutes.employee-insights.ai-call-failed");
        insightEngine = "rules";
      }
    } else {
      analysis = fallbackAnalysis;
      insights = fallbackAnalysis.insights;
      recordAiFallback(
        "productivityRoutes.employee-insights.ai-skipped-no-config",
      );
      aiStatus = "skipped";
      insightEngine = "rules";
    }

    return res.json({
      stats,
      insights,
      analysis: analysis || {
        ...fallbackAnalysis,
        insights,
      },
      aiStatus,
      insightEngine,
    });
  } catch (err) {
    console.error("Productivity insights error:", err.message);
    return res.status(500).json({ error: "Failed to compute insights" });
  }
});

export default router;
