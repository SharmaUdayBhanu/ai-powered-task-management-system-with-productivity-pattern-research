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

const clampText = (value, max = 120) => {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

const pillHeadlineKey = (headline) =>
  String(headline || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const normalizeInsightPill = (item, fallbackSource = "ai") => {
  if (item == null) return null;
  if (typeof item === "string") {
    const t = item.trim();
    if (!t) return null;
    return {
      headline: clampText(t, 100),
      rationale: t,
      source: fallbackSource,
    };
  }
  if (typeof item === "object") {
    const headline = clampText(
      item.headline || item.title || item.label || item.text || "",
      100,
    );
    const rationale = String(
      item.rationale || item.why || item.reason || headline,
    ).trim();
    if (!headline) return null;
    const src =
      item.source === "sys" || item.source === "SYS" ? "sys" : fallbackSource;
    return { headline, rationale: rationale || headline, source: src };
  }
  return null;
};

const normalizePillArray = (raw, max = 5, fallbackSource = "ai") => {
  const arr = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  for (const x of arr) {
    const p = normalizeInsightPill(x, fallbackSource);
    if (!p) continue;
    const k = pillHeadlineKey(p.headline);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(p);
    if (out.length >= max) break;
  }
  return out;
};

const dedupePillsAcrossSections = (
  quickPills,
  riskPills,
  maxQuick = 4,
  maxRisk = 3,
) => {
  const riskKeys = new Set(riskPills.map((p) => pillHeadlineKey(p.headline)));
  const quickFiltered = quickPills.filter(
    (p) => !riskKeys.has(pillHeadlineKey(p.headline)),
  );
  const quickKeys = new Set(
    quickFiltered.map((p) => pillHeadlineKey(p.headline)),
  );
  const riskFiltered = riskPills.filter(
    (p) => !quickKeys.has(pillHeadlineKey(p.headline)),
  );
  return [quickFiltered.slice(0, maxQuick), riskFiltered.slice(0, maxRisk)];
};

const filterPillsAgainstMetrics = (pills, metrics = {}) =>
  pills.filter((p) => !contradictsCoreMetrics(p.rationale || p.headline, metrics));

const normalizeEmployeeAiAnalysis = (raw, metrics = {}) => {
  if (!raw || typeof raw !== "object") return null;

  let quick = normalizePillArray(raw.quickActions, 6, "ai");
  let risk = normalizePillArray(raw.riskSignals, 6, "ai");

  if (!quick.length && Array.isArray(raw.insights)) {
    quick = normalizePillArray(raw.insights, 6, "ai");
  }
  if (!risk.length && Array.isArray(raw.riskAlerts)) {
    risk = normalizePillArray(raw.riskAlerts, 6, "ai");
  }

  quick = filterPillsAgainstMetrics(quick, metrics);
  risk = filterPillsAgainstMetrics(risk, metrics);

  [quick, risk] = dedupePillsAcrossSections(quick, risk, 4, 3);

  let workloadOutlook = normalizeInsightPill(raw.workloadOutlook, "ai");
  if (workloadOutlook) {
    const ok = filterPillsAgainstMetrics([workloadOutlook], metrics);
    workloadOutlook = ok[0] || null;
  }

  const pattern = String(raw.pattern || "").trim();
  const specialization = String(raw.specialization || "").trim();
  const consistency = String(raw.consistency || "").trim();
  const comparativeSignal = String(raw.comparativeSignal || "").trim();

  const changeDetectionRaw =
    raw.changeDetection && typeof raw.changeDetection === "object"
      ? raw.changeDetection
      : {};
  const changeStatus = String(changeDetectionRaw.status || "").trim();
  const changeReason = String(changeDetectionRaw.reason || "").trim();

  if (!quick.length && !risk.length && !pattern) return null;

  return {
    quickActionPills: quick,
    riskPills: risk,
    workloadOutlook,
    pattern,
    specialization,
    consistency,
    comparativeSignal,
    changeDetection: {
      status: changeStatus,
      reason: changeReason,
    },
    insights: quick.map((p) => p.headline),
    riskSignals: risk.map((p) => p.rationale),
  };
};

const normalizeAdminRecommendationPill = (item) => {
  if (item == null) return null;
  if (typeof item === "string") {
    const t = item.trim();
    if (!t) return null;
    return { headline: clampText(t, 100), rationale: t, source: "ai" };
  }
  if (typeof item === "object") {
    const headline = clampText(item.headline || item.title || "", 100);
    const rationale = String(item.rationale || item.why || headline).trim();
    if (!headline) return null;
    return { headline, rationale: rationale || headline, source: "ai" };
  }
  return null;
};

const normalizeAdminInsights = (raw) => {
  if (!raw || typeof raw !== "object") return null;

  const summary = String(raw.summary || "").trim();
  const topPerformer = String(raw.topPerformer || "").trim();
  const mostImproved = String(raw.mostImproved || "").trim();
  const needsAttention = String(raw.needsAttention || "").trim();

  let recommendations = Array.isArray(raw.recommendations)
    ? raw.recommendations
        .map((item) => normalizeAdminRecommendationPill(item))
        .filter(Boolean)
        .slice(0, 6)
    : [];

  const teamPattern = String(raw.teamPattern || "").trim();
  const workloadImbalance = String(raw.workloadImbalance || "").trim();
  const failureClusters = String(raw.failureClusters || "").trim();

  let teamDiagnostics = Array.isArray(raw.teamDiagnostics)
    ? raw.teamDiagnostics
        .map((item) => normalizeInsightPill(item, "ai"))
        .filter(Boolean)
        .slice(0, 8)
    : [];

  if (!teamDiagnostics.length) {
    if (teamPattern) {
      teamDiagnostics.push(
        normalizeInsightPill(
          { headline: "Team cadence", rationale: teamPattern },
          "ai",
        ),
      );
    }
    if (workloadImbalance) {
      teamDiagnostics.push(
        normalizeInsightPill(
          { headline: "Workload balance", rationale: workloadImbalance },
          "ai",
        ),
      );
    }
    if (failureClusters) {
      teamDiagnostics.push(
        normalizeInsightPill(
          { headline: "Failure concentration", rationale: failureClusters },
          "ai",
        ),
      );
    }
  }

  const tdSeen = new Set();
  teamDiagnostics = teamDiagnostics.filter((p) => {
    const k = pillHeadlineKey(p.headline);
    if (!k || tdSeen.has(k)) return false;
    tdSeen.add(k);
    return true;
  });

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
    needsAttention,
    teamPattern,
    workloadImbalance,
    failureClusters,
    teamDiagnostics,
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

const buildEmployeePatternFallback = (input) => {
  const metrics = input?.metrics || {};
  const completionRate = Number(metrics.completionRate) || 0;
  const onTimePercent = Number(metrics.onTimePercent) || 0;
  const delayedPercent = Number(metrics.delayedPercent) || 0;
  const failedTasks = Number(metrics.failedTasks) || 0;
  const completedTasks = Number(metrics.completedTasks) || 0;
  const avgCompletion = Number(metrics.averageCompletionTimeMinutes) || 0;
  const trendDelta = Number(metrics.productivityTrendDelta) || 0;
  const totalTasks = Number(metrics.totalTasks) || 0;
  const peakWindow = String(metrics.peakProductivityWindow || "N/A");
  const activeTasks = Number(input?.taskCounts?.active) || 0;
  const newTasks = Number(input?.taskCounts?.newTask) || 0;
  const completedLast7 = Number(metrics.completedLast7Days) || 0;
  const completedPrev7 = Number(metrics.completedPrevious7Days) || 0;
  const peer = input?.teamBaseline || {};
  const name = String(input?.employee?.name || "This employee").trim() || "This employee";

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
    peer.peerCount > 0
      ? `${name} is at ${metrics.productivityScore ?? 0} productivity score vs peer average ${peer.avgProductivityScore}; on-time ${onTimePercent}% vs peers ${peer.avgOnTimePercent}%; last-7-days completions ${completedLast7} vs peer avg ${peer.avgCompletedLast7}.`
      : completedTasks >= 6
        ? "Above baseline throughput pattern with sustained completion cadence."
        : failedTasks >= 3
          ? "Outcome reliability is weaker when failures cluster against completions."
          : "Performance signal sits near baseline with no extreme variance in current counts.";

  const quickActionPills = [];
  quickActionPills.push({
    headline: `Tune weekly rhythm (${completedLast7} vs ${completedPrev7})`,
    rationale: `${name} closed ${completedLast7} tasks in the last 7 days and ${completedPrev7} in the prior 7 days (delta ${trendDelta}). With ${completionRate}% completion rate across ${totalTasks} tasks, prioritize the next closures that move this delta in the right direction.`,
    source: "sys",
  });

  if (delayedPercent >= 35 && completedTasks > 0) {
    quickActionPills.push({
      headline: `Recover on-time (${onTimePercent}% on-time)`,
      rationale: `Among timed completions, delayed share is ${delayedPercent}% and on-time is ${onTimePercent}%. Average completion duration is ${avgCompletion} minutes—tighten checkpoints on tasks with hard dates.`,
      source: "sys",
    });
  }

  if (activeTasks > 0 || newTasks > 0) {
    quickActionPills.push({
      headline: `Sequence ${activeTasks} active / ${newTasks} new tasks`,
      rationale: `Queue shows ${activeTasks} active and ${newTasks} new assignments while ${failedTasks} tasks failed and ${completedTasks} completed in the dataset—finish one active item before pulling additional scope.`,
      source: "sys",
    });
  }

  if (input?.recentAction?.taskTitle && input?.recentAction?.taskStatus) {
    quickActionPills.push({
      headline: `Follow up: ${clampText(input.recentAction.taskTitle, 40)}`,
      rationale: `Most recent tracked action is "${input.recentAction.taskTitle}" marked ${input.recentAction.taskStatus}. Use that outcome to choose the next concrete task step.`,
      source: "sys",
    });
  }

  const riskPills = [];
  if (failedTasks >= 2) {
    riskPills.push({
      headline: `Failure load (${failedTasks}) vs ${completedTasks} wins`,
      rationale: `${name} has ${failedTasks} failed tasks against ${completedTasks} completions, so reliability risk rises if new work stacks before root causes are reviewed.`,
      source: "sys",
    });
  }
  if (activeTasks + newTasks >= 8) {
    riskPills.push({
      headline: `Context-switch load (${activeTasks + newTasks} open)`,
      rationale: `Open assignments total ${activeTasks} active plus ${newTasks} new—high parallel load often extends cycle times beyond the ${avgCompletion} minute average.`,
      source: "sys",
    });
  }
  if (totalTasks > 0 && completedTasks === 0) {
    riskPills.push({
      headline: "No completions captured yet",
      rationale: `There are ${totalTasks} visible tasks but zero completions recorded—delivery risk until a first clean finish proves the workflow.`,
      source: "sys",
    });
  }
  if (!riskPills.length) {
    riskPills.push({
      headline: "No acute risk flag in this snapshot",
      rationale: `Given ${failedTasks} failures, ${completedTasks} completions, and ${activeTasks + newTasks} open assignments, nothing crosses an automatic critical threshold—still monitor week-over-week deltas.`,
      source: "sys",
    });
  }

  let workloadHeadline = "Balanced queue depth";
  if (activeTasks + newTasks === 0) {
    workloadHeadline = "Very light assigned queue";
  } else if (activeTasks + newTasks >= 8) {
    workloadHeadline = "Heavy parallel queue";
  } else if (completedLast7 === 0 && totalTasks > 0) {
    workloadHeadline = "Assigned work but quiet week";
  }

  const workloadOutlook = {
    headline: workloadHeadline,
    rationale: `${name} carries ${activeTasks} active and ${newTasks} new tasks, with ${completedLast7} completions in the last 7 days and productivity score ${metrics.productivityScore ?? 0} (from completed/failed counts).`,
    source: "sys",
  };

  const [qa, rp] = dedupePillsAcrossSections(quickActionPills, riskPills, 4, 3);

  return {
    quickActionPills: qa,
    riskPills: rp,
    workloadOutlook,
    pattern,
    specialization,
    consistency,
    changeDetection,
    comparativeSignal,
    insights: qa.map((p) => p.headline),
    riskSignals: rp.map((p) => p.rationale),
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
  const failedTasks = Number(metrics.failedTasks) || 0;
  const name = String(input?.employee?.name || "This employee").trim() || "This employee";

  const quickActionPills = [];
  if (completedTasks > 0) {
    quickActionPills.push({
      headline: `Log the next win after ${completedTasks} completion${completedTasks > 1 ? "s" : ""}`,
      rationale: `${name} has only ${completedTasks} completed task${completedTasks > 1 ? "s" : ""}${completedLast7 ? ` including ${completedLast7} in the last 7 days` : ""} across ${totalTasks} visible tasks—add one more clean finish before drawing strong conclusions.`,
      source: "sys",
    });
  } else {
    quickActionPills.push({
      headline: "Capture a first clean completion",
      rationale: `With ${totalTasks} visible tasks and zero recorded completions, the next step is to finish one task end-to-end so timing and reliability metrics can populate.`,
      source: "sys",
    });
  }

  quickActionPills.push({
    headline: "Defer deep pattern reads",
    rationale: `Dataset is below the insight threshold (${totalTasks} tasks, ${completedTasks} completions, ${failedTasks} failures)—treat any trend language as provisional.`,
    source: "sys",
  });

  const riskPills = [
    {
      headline: "Low statistical confidence",
      rationale: `Only ${completedTasks} completions and ${failedTasks} failures are available; small samples can exaggerate swings in on-time and productivity scores.`,
      source: "sys",
    },
  ];

  const [qa, rp] = dedupePillsAcrossSections(quickActionPills, riskPills, 4, 3);

  return {
    quickActionPills: qa,
    riskPills: rp,
    workloadOutlook: {
      headline: "Workload signal not stable yet",
      rationale: `${name} shows ${totalTasks} tasks with ${completedTasks} completions—queue posture will be clearer after more outcomes.`,
      source: "sys",
    },
    pattern:
      "Insufficient historical data for a stable execution pattern; baseline capture in progress.",
    specialization:
      "Not enough completed volume yet to infer specialization reliably.",
    consistency: "low-confidence (insufficient completed-task sample)",
    insights: qa.map((p) => p.headline),
    riskSignals: rp.map((p) => p.rationale),
    changeDetection: {
      status: "stable",
      reason:
        "Insufficient week-over-week volume to classify meaningful directional change.",
    },
    comparativeSignal:
      "Comparative signal is low-confidence until a larger completion history is available.",
  };
};

const enrichEmployeeAnalysis = (aiAnalysis, fallbackAnalysis) => {
  if (!fallbackAnalysis || typeof fallbackAnalysis !== "object") {
    return aiAnalysis;
  }
  if (!aiAnalysis || typeof aiAnalysis !== "object") {
    return { ...fallbackAnalysis };
  }

  let quick = Array.isArray(aiAnalysis.quickActionPills)
    ? [...aiAnalysis.quickActionPills]
    : [];
  let risk = Array.isArray(aiAnalysis.riskPills) ? [...aiAnalysis.riskPills] : [];

  if (!quick.length && Array.isArray(aiAnalysis.insights)) {
    quick = aiAnalysis.insights
      .map((h) =>
        normalizeInsightPill({ headline: h, rationale: String(h) }, "ai"),
      )
      .filter(Boolean);
  }
  if (!risk.length && Array.isArray(aiAnalysis.riskSignals)) {
    risk = aiAnalysis.riskSignals
      .map((t) => {
        const text = String(t || "").trim();
        if (!text) return null;
        return normalizeInsightPill(
          { headline: clampText(text, 90), rationale: text },
          "ai",
        );
      })
      .filter(Boolean);
  }

  const fbQuick = fallbackAnalysis.quickActionPills || [];
  const fbRisk = fallbackAnalysis.riskPills || [];

  if (!quick.length) quick = [...fbQuick];
  if (!risk.length) risk = [...fbRisk];

  [quick, risk] = dedupePillsAcrossSections(quick, risk, 4, 3);

  return {
    ...fallbackAnalysis,
    ...aiAnalysis,
    quickActionPills: quick,
    riskPills: risk,
    workloadOutlook:
      aiAnalysis.workloadOutlook || fallbackAnalysis.workloadOutlook,
    pattern: aiAnalysis.pattern || fallbackAnalysis.pattern,
    specialization:
      aiAnalysis.specialization || fallbackAnalysis.specialization,
    consistency: aiAnalysis.consistency || fallbackAnalysis.consistency,
    comparativeSignal:
      aiAnalysis.comparativeSignal || fallbackAnalysis.comparativeSignal,
    changeDetection: aiAnalysis.changeDetection?.status
      ? aiAnalysis.changeDetection
      : fallbackAnalysis.changeDetection,
    insights: quick.map((p) => p.headline),
    riskSignals: risk.map((p) => p.rationale),
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
  const lowestPerformer = allEmployees[allEmployees.length - 1];

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

  const recommendationStrings = [
    `Route higher-priority work to employees with on-time rate above ${Math.max(70, Math.round(topPerformer.onTimePercent - 5))}%.`,
    `Coach employees with negative trend deltas using recent failed-task reviews and shorter milestone check-ins.`,
    `Use completion-time outliers to rebalance workload and protect team average completion time (${dashboardSummary.averageCompletionTimeMinutes} min).`,
  ];

  const recommendationPills = recommendationStrings
    .map((t) =>
      normalizeInsightPill(
        {
          headline: clampText(t.split(".")[0] || t, 100),
          rationale: t,
        },
        "sys",
      ),
    )
    .filter(Boolean);

  const teamDiagnosticPillsRaw = [
    normalizeInsightPill({ headline: "Team cadence", rationale: teamPattern }, "sys"),
    normalizeInsightPill(
      { headline: "Workload balance", rationale: workloadImbalance },
      "sys",
    ),
    normalizeInsightPill(
      { headline: "Failure concentration", rationale: failureClusters },
      "sys",
    ),
  ];
  if (underutilized.length) {
    teamDiagnosticPillsRaw.push(
      normalizeInsightPill(
        {
          headline: "Bench / low utilization",
          rationale: `Employees with zero last-7-days completions: ${underutilized.join(", ")}.`,
        },
        "sys",
      ),
    );
  }
  changeSignals.slice(0, 4).forEach((line) => {
    teamDiagnosticPillsRaw.push(
      normalizeInsightPill(
        {
          headline: clampText(line, 88),
          rationale: line,
        },
        "sys",
      ),
    );
  });

  const diagSeen = new Set();
  const teamDiagnosticPills = teamDiagnosticPillsRaw.filter((p) => {
    const k = pillHeadlineKey(p.headline);
    if (!k || diagSeen.has(k)) return false;
    diagSeen.add(k);
    return true;
  });

  return {
    summary: `Team completion rate is ${dashboardSummary.completionRate}% across ${dashboardSummary.totalTasks} tasks. ${topPerformer.name} currently leads with score ${topPerformer.productivityScore}, while trend monitoring should focus on employees with negative weekly deltas.`,
    topPerformer: `${topPerformer.name} leads with score ${topPerformer.productivityScore} and ${topPerformer.onTimePercent.toFixed(1)}% on-time delivery.`,
    mostImproved: `${mostImproved.name} shows the strongest recent trend delta (${mostImproved.trendDelta >= 0 ? "+" : ""}${mostImproved.trendDelta}).`,
    needsAttention: `${lowestPerformer.name} has the lowest productivity score (${lowestPerformer.productivityScore}) with ${lowestPerformer.totalFailed} failed tasks and ${lowestPerformer.completedLast7} completions in the last 7 days (trend delta ${lowestPerformer.trendDelta >= 0 ? "+" : ""}${lowestPerformer.trendDelta}).`,
    teamPattern,
    workloadImbalance,
    failureClusters,
    underutilizedEmployees: underutilized,
    changeSignals,
    employeeInsights,
    expertAreas,
    recommendations: recommendationStrings,
    recommendationPills,
    teamDiagnosticPills,
    teamDiagnostics: teamDiagnosticPills,
  };
};

const adminPickRichText = (preferred, fallback) => {
  const p = String(preferred || "").trim();
  if (p.length >= 28) return p;
  const f = String(fallback || "").trim();
  return f || p;
};

const adminRecommendationToPill = (item, source) => {
  if (!item) return null;
  if (typeof item === "object" && item.headline && item.rationale) {
    return { ...item, source: item.source || source };
  }
  if (typeof item === "object" && item.rationale) {
    return normalizeInsightPill(
      {
        headline: item.headline || clampText(String(item.rationale).split(".")[0], 100),
        rationale: item.rationale,
      },
      source,
    );
  }
  const text = String(item).trim();
  if (!text) return null;
  return normalizeInsightPill(
    {
      headline: clampText(text.split(".")[0] || text, 100),
      rationale: text,
    },
    source,
  );
};

const dedupeAdminPillsPreferOrder = (pills) => {
  const seen = new Set();
  const out = [];
  for (const p of pills) {
    const k = pillHeadlineKey(p.headline);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
};

const reconcileAdminInsights = ({ candidate, dashboardSummary, allEmployees }) => {
  const baseline = generateAdminDataDrivenInsights({
    dashboardSummary,
    allEmployees,
  });

  if (!baseline) return null;

  const baseRecPills = (baseline.recommendationPills || []).map((p) => ({
    ...p,
    source: "sys",
  }));
  const baseTeamPills = baseline.teamDiagnosticPills || [];

  if (!candidate) {
    return {
      ...baseline,
      recommendationPills: baseRecPills,
      teamDiagnosticPills: baseTeamPills,
      teamDiagnostics: baseTeamPills,
    };
  }

  const candRecPills = (Array.isArray(candidate.recommendations)
    ? candidate.recommendations
    : []
  )
    .map((r) => adminRecommendationToPill(r, "ai"))
    .filter(Boolean);

  const mergedRecPills = dedupeAdminPillsPreferOrder([
    ...candRecPills,
    ...baseRecPills,
  ]).slice(0, 6);

  const candTeamPills = Array.isArray(candidate.teamDiagnostics)
    ? candidate.teamDiagnostics
        .map((t) => normalizeInsightPill(t, "ai"))
        .filter(Boolean)
    : [];

  const mergedTeamPills = dedupeAdminPillsPreferOrder([
    ...candTeamPills,
    ...baseTeamPills,
  ]).slice(0, 10);

  return {
    ...candidate,
    summary: adminPickRichText(candidate.summary, baseline.summary),
    topPerformer: adminPickRichText(candidate.topPerformer, baseline.topPerformer),
    mostImproved: adminPickRichText(candidate.mostImproved, baseline.mostImproved),
    needsAttention: adminPickRichText(
      candidate.needsAttention,
      baseline.needsAttention,
    ),
    teamPattern: baseline.teamPattern,
    workloadImbalance: baseline.workloadImbalance,
    failureClusters: baseline.failureClusters,
    underutilizedEmployees:
      Array.isArray(candidate.underutilizedEmployees) &&
      candidate.underutilizedEmployees.length
        ? candidate.underutilizedEmployees
        : baseline.underutilizedEmployees,
    changeSignals:
      Array.isArray(candidate.changeSignals) && candidate.changeSignals.length
        ? candidate.changeSignals
        : baseline.changeSignals,
    employeeInsights:
      Array.isArray(candidate.employeeInsights) &&
      candidate.employeeInsights.length
        ? candidate.employeeInsights
        : baseline.employeeInsights,
    expertAreas: {
      ...baseline.expertAreas,
      ...(candidate.expertAreas || {}),
    },
    recommendations: mergedRecPills.map((p) => p.rationale),
    recommendationPills: mergedRecPills,
    teamDiagnosticPills: mergedTeamPills,
    teamDiagnostics: mergedTeamPills,
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
        insightEngine: "sys",
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
    let insightEngine = "sys";
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
        insightEngine = "sys";
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
      insightEngine = cachedRankings.insightEngine || "sys";
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
            maxRetries: 2,
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
          insightEngine = "sys";
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
        insightEngine = "sys";
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
      insightEngine = cachedRankings.insightEngine || "sys";
      cached = true;
    }

    if (!aiInsights) {
      aiInsights = reconcileAdminInsights({
        candidate: null,
        dashboardSummary,
        allEmployees,
      });
      recordAiFallback("productivityRoutes.rankings.empty-insights");
      insightEngine = "sys";
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
        insightEngine: "sys",
        lowData: true,
      });
    }

    if (
      !forceRefresh &&
      !hasActionContext &&
      !postOutcomeFreshnessRequired &&
      isFresh(employee.lastInsightUpdate, AI_INSIGHTS_TTL_MS) &&
      ((employee.storedInsightAnalysis &&
        typeof employee.storedInsightAnalysis === "object") ||
        (Array.isArray(employee.storedInsights) &&
          employee.storedInsights.length > 0))
    ) {
      let cachedAnalysis = null;
      if (
        employee.storedInsightAnalysis &&
        typeof employee.storedInsightAnalysis === "object"
      ) {
        const { persistedEngine: _pe, ...storedPayload } =
          employee.storedInsightAnalysis;
        cachedAnalysis = enrichEmployeeAnalysis(
          storedPayload,
          fallbackAnalysis,
        );
      } else if (
        Array.isArray(employee.storedInsights) &&
        employee.storedInsights.length
      ) {
        const legacyQuick = employee.storedInsights
          .map((h) =>
            normalizeInsightPill(
              { headline: String(h), rationale: String(h) },
              "sys",
            ),
          )
          .filter(Boolean);
        cachedAnalysis = enrichEmployeeAnalysis(
          {
            quickActionPills: legacyQuick.slice(0, 4),
            insights: legacyQuick.slice(0, 4).map((p) => p.headline),
          },
          fallbackAnalysis,
        );
      } else {
        cachedAnalysis = { ...fallbackAnalysis };
      }

      const persistedEngine = employee.storedInsightAnalysis?.persistedEngine;

      return res.json({
        stats,
        insights: cachedAnalysis.insights,
        analysis: cachedAnalysis,
        cached: true,
        aiStatus: "cached",
        insightEngine: persistedEngine === "ai" ? "ai" : "sys",
      });
    }

    if (Date.now() < cooldownUntil) {
      const partial =
        employee.storedInsightAnalysis &&
        typeof employee.storedInsightAnalysis === "object"
          ? (() => {
              const { persistedEngine: _pe, ...rest } =
                employee.storedInsightAnalysis;
              return rest;
            })()
          : Array.isArray(employee.storedInsights) &&
              employee.storedInsights.length
            ? {
                quickActionPills: employee.storedInsights
                  .map((h) =>
                    normalizeInsightPill(
                      { headline: String(h), rationale: String(h) },
                      "sys",
                    ),
                  )
                  .filter(Boolean),
              }
            : null;

      const rateAnalysis = enrichEmployeeAnalysis(partial, fallbackAnalysis);

      return res.json({
        stats,
        insights: rateAnalysis.insights,
        analysis: rateAnalysis,
        cached: true,
        rateLimited: true,
        aiStatus: "retry",
        insightEngine: "sys",
      });
    }

    // Generate AI-powered insights with dedupe/cooldown protection.
    let insights = [];
    let analysis = null;
    let aiStatus = "fallback";
    let insightEngine = "sys";
    if (hasAiClientConfig()) {
      try {
        const prompt = buildEmployeeInsightsPrompt({
          input: structuredInsightsInput,
        });

        const computeInsights = async () => {
          const raw = await callGemini(prompt, {
            maxRetries: 2,
            baseDelayMs: 2000,
            context: "productivity-employee-insights",
            lockKey: insightsKey,
          });
          return safeParseJson(raw, {});
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

        const normalizedAnalysis = normalizeEmployeeAiAnalysis(
          parsed,
          structuredInsightsInput.metrics || {},
        );
        const aiLooksValid =
          normalizedAnalysis &&
          (normalizedAnalysis.quickActionPills?.length ||
            normalizedAnalysis.insights?.length ||
            normalizedAnalysis.pattern);

        if (aiLooksValid) {
          analysis = enrichEmployeeAnalysis(
            normalizedAnalysis,
            fallbackAnalysis,
          );
          insights = analysis.insights;
          aiStatus = "ready";
          insightEngine = "ai";
        } else {
          analysis = fallbackAnalysis;
          insights = fallbackAnalysis.insights;
          recordAiFallback(
            "productivityRoutes.employee-insights.invalid-ai-output",
          );
          aiStatus = "fallback";
          insightEngine = "sys";
        }

        // Store insights in database using atomic update to avoid version conflicts.
        await Employee.findByIdAndUpdate(employee._id, {
          $set: {
            storedInsights: insights,
            storedInsightAnalysis: { ...analysis, persistedEngine: insightEngine },
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
        const partial =
          employee.storedInsightAnalysis &&
          typeof employee.storedInsightAnalysis === "object"
            ? (() => {
                const { persistedEngine: _pe, ...rest } =
                  employee.storedInsightAnalysis;
                return rest;
              })()
            : Array.isArray(employee.storedInsights) &&
                employee.storedInsights.length
              ? {
                  quickActionPills: employee.storedInsights
                    .map((h) =>
                      normalizeInsightPill(
                        { headline: String(h), rationale: String(h) },
                        "sys",
                      ),
                    )
                    .filter(Boolean),
                }
              : null;

        analysis = enrichEmployeeAnalysis(partial, fallbackAnalysis);
        insights = analysis.insights;
        recordAiFallback("productivityRoutes.employee-insights.ai-call-failed");
        insightEngine = "sys";
      }
    } else {
      analysis = fallbackAnalysis;
      insights = fallbackAnalysis.insights;
      recordAiFallback(
        "productivityRoutes.employee-insights.ai-skipped-no-config",
      );
      aiStatus = "skipped";
      insightEngine = "sys";
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
