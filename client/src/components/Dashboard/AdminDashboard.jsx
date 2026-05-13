import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import axios from "axios";
import getSocket from "../../lib/socket";
import Header from "../other/Header";
import CreateTask from "../other/CreateTask";
import EmployeeAutocomplete from "../EmployeeAutocomplete";
import TaskChatDock from "../TaskChat/TaskChatDock";
import {
  getWithRetry,
  postWithRetry,
  sanitizeApiError,
  default as API_URL,
} from "../../lib/apiClient";
import { ENABLE_REALTIME } from "../../lib/realtime";
import ActionableInsightList from "../ActionableInsightList";
import DataSourceBadge from "../DataSourceBadge";

const toPercent = (value, base) => {
  const safeBase = Number(base) || 0;
  if (safeBase <= 0) return 0;
  return Number(((Number(value) / safeBase) * 100).toFixed(1));
};

const formatSyncTime = (date) =>
  date
    ? date.toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      })
    : "Syncing...";

const getTrendMeta = (stats = {}) => {
  const backendLabel = String(stats?.trendLabel || "").trim();
  if (backendLabel === "Improving") {
    return {
      label: "Improving",
      icon: "↗",
      className: "bg-emerald-500/20 text-emerald-300",
    };
  }
  if (backendLabel === "Declining") {
    return {
      label: "Declining",
      icon: "↘",
      className: "bg-red-500/20 text-red-300",
    };
  }

  const delta = Number(stats?.productivityTrendDelta) || 0;
  const completed = Number(stats?.completedTaskCount) || 0;
  const failed = Number(stats?.failedTaskCount) || 0;
  const completionRate = Number(stats?.outcomeCompletionRate) || 0;
  const lowData = completed + failed < 2;

  if (!backendLabel && !lowData) {
    if (delta >= 2 || (delta > 0 && completionRate >= 65)) {
      return {
        label: "Improving",
        icon: "↗",
        className: "bg-emerald-500/20 text-emerald-300",
      };
    }
    if (delta <= -2 || completionRate < 45 || failed > completed) {
      return {
        label: "Declining",
        icon: "↘",
        className: "bg-red-500/20 text-red-300",
      };
    }
  }

  return {
    label: lowData ? "Stable (Low Data)" : "Stable",
    icon: "→",
    className: "bg-yellow-500/20 text-yellow-300",
  };
};

const deriveStrengthTags = ({ ranking }) => {
  const tags = [];
  const stats = ranking?.stats || {};
  const onTime = Number(stats.onTimePercent) || 0;
  const avgTime = Number(ranking?.stats?.averageCompletionTimeMinutes) || 0;
  const throughput = Number(ranking?.stats?.completedLast7Days) || 0;
  const completed = Number(stats.completedTaskCount) || 0;
  const failed = Number(stats.failedTaskCount) || 0;
  const lowData = completed + failed < 3;

  if (lowData) {
    return ["Early Signal", "Needs More Data"];
  }

  if (onTime >= 85) tags.push("Deadline Reliability");
  if (avgTime > 0 && avgTime <= 60) tags.push("Fast Execution");
  if (throughput >= 5) tags.push("High Throughput");
  if (completed >= 8 && failed <= 2) tags.push("Consistent Delivery");
  if (failed === 0 && completed > 0) tags.push("Zero Failure Streak");

  if (!tags.length) {
    tags.push("Needs Coaching");
  }

  return tags.slice(0, 3);
};

const getTaskActivityTimestamp = (task = {}) => {
  const source =
    task.completedAt ||
    task.submittedAt ||
    task.startedAt ||
    task.acceptedAt ||
    task.assignedAt ||
    task.createdAt ||
    task.taskDate;

  const parsed = new Date(source || 0).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
};

const deriveCardSignalFallback = (stats = {}) => {
  const completed = Number(stats.completedTaskCount) || 0;
  const failed = Number(stats.failedTaskCount) || 0;
  const onTime = Number(stats.onTimePercent) || 0;
  const avgTime = Number(stats.averageCompletionTimeMinutes) || 0;
  const trendLabel = String(stats.trendLabel || "Stable");
  const lowData = completed + failed < 3;

  if (lowData) {
    return {
      pattern: "Early-stage data: pattern confidence is still low.",
      riskSignal: "Neutral risk posture until more outcomes are recorded.",
      specialization: "Specialization not inferable yet.",
      changeSignal: "Stable (low data)",
    };
  }

  return {
    pattern:
      avgTime > 0 && avgTime <= 60
        ? "Short-cycle execution pattern with faster turnaround."
        : "Measured execution pattern with deeper task cycles.",
    riskSignal:
      failed >= Math.max(2, completed * 0.6)
        ? "Failure ratio is elevated; review blockers and handoffs."
        : "No strong failure cluster in current outcomes.",
    specialization:
      onTime >= 80
        ? "Deadline reliability is a consistent strength."
        : "Execution consistency can improve with tighter checkpoints.",
    changeSignal: `${trendLabel} trend in recent weekly cadence.`,
  };
};

const getWorkloadStatus = ({ employee = {}, ranking = {}, stats = {} }) => {
  const activeCount =
    Number(stats.activeTaskCount) || Number(employee.taskCounts?.active) || 0;
  const pendingCount = Number(employee.taskCounts?.newTask) || 0;
  const workloadCount = activeCount + pendingCount;
  const completed = Number(stats.completedTaskCount) || 0;
  const failed = Number(stats.failedTaskCount) || 0;
  const totalOutcomes = completed + failed;
  const completionRate =
    Number(stats.outcomeCompletionRate) || toPercent(completed, totalOutcomes);
  const productivityScore =
    Number(ranking?.productivityScore) || Number(stats.productivityScore) || 0;
  const hasOutcomeHistory = totalOutcomes > 0;
  const struggling =
    hasOutcomeHistory &&
    (completionRate < 60 || failed > completed * 0.5 || productivityScore < 4);
  const capable =
    productivityScore >= 5 ||
    completionRate >= 70 ||
    completed >= Math.max(3, failed * 2);

  if (
    workloadCount >= 8 ||
    (workloadCount >= 6 &&
      (struggling || (hasOutcomeHistory && completionRate < 75)))
  ) {
    return {
      label: "Overloaded",
      detail: `${workloadCount} active/new tasks with ${completionRate}% completion`,
      className: "bg-red-500/20 text-red-300 border-red-400/30",
    };
  }

  if (workloadCount <= 1 && capable) {
    return {
      label: "Underutilized",
      detail: `${workloadCount} active/new tasks with capacity to take more`,
      className: "bg-sky-500/20 text-sky-300 border-sky-400/30",
    };
  }

  return {
    label: "Balanced",
    detail: `${workloadCount} active/new tasks with steady delivery`,
    className: "bg-emerald-500/20 text-emerald-300 border-emerald-400/30",
  };
};

const parseDurationMinutes = (value) => {
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
      const average = (first + second) / 2;
      const isHours = /(hour|hours|hr|hrs)\b/.test(text);
      return Math.max(1, Math.round(isHours ? average * 60 : average));
    }
  }

  const hoursMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)\b/);
  if (hoursMatch) {
    const num = Number(hoursMatch[1]);
    return Number.isNaN(num) ? 0 : Math.max(1, Math.round(num * 60));
  }

  const minutesMatch = text.match(
    /(\d+(?:\.\d+)?)\s*(?:m|min|mins|minute|minutes)\b/,
  );
  if (minutesMatch) {
    const num = Number(minutesMatch[1]);
    return Number.isNaN(num) ? 0 : Math.max(1, Math.round(num));
  }

  const numericOnly = text.match(/\d+(?:\.\d+)?/);
  if (numericOnly) {
    const num = Number(numericOnly[0]);
    return Number.isNaN(num) ? 0 : Math.max(1, Math.round(num));
  }

  return 0;
};

const getTaskStartMs = (task = {}) => {
  const source =
    task.startedAt || task.acceptedAt || task.assignedAt || task.createdAt;
  const parsed = new Date(source || 0).getTime();
  return Number.isNaN(parsed) ? null : parsed;
};

const formatRemainingTime = (remainingMs) => {
  if (remainingMs === null || remainingMs === undefined) {
    return "Not enough data";
  }
  const totalMinutes = Math.ceil(Math.abs(remainingMs) / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const label = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
  if (remainingMs < 0) return `Overdue by ${label}`;
  return `${label} left`;
};

const AdminDashboard = () => {
  const [theme, setTheme] = useState("dark");
  const [employees, setEmployees] = useState([]);
  const [leaderboardData, setLeaderboardData] = useState({
    leaderboard: [],
    summary: {
      totalTasks: 0,
      completionRate: 0,
      productivityScore: 0,
      averageCompletionTimeMinutes: 0,
    },
    aiInsights: null,
  });
  const [loading, setLoading] = useState(true);
  const [aiLoading, setAiLoading] = useState(false);
  const [error, setError] = useState("");
  const [lastSync, setLastSync] = useState(null);
  const aiRefreshTimeoutRef = useRef(null);
  const aiRequestInFlightRef = useRef(false);

  const [showAddEmployeeForm, setShowAddEmployeeForm] = useState(false);
  const [addEmployeeLoading, setAddEmployeeLoading] = useState(false);
  const [addEmployeeError, setAddEmployeeError] = useState("");
  const [addEmployeeForm, setAddEmployeeForm] = useState({
    firstName: "",
    lastName: "",
    email: "",
    role: "employee",
  });
  const [employeeSearch, setEmployeeSearch] = useState("");
  const [editingEmployeeEmail, setEditingEmployeeEmail] = useState("");
  const [employeeActionError, setEmployeeActionError] = useState("");
  const [employeeActionSuccess, setEmployeeActionSuccess] = useState("");
  const [editEmployeeForm, setEditEmployeeForm] = useState({
    firstName: "",
    lastName: "",
    email: "",
    role: "",
  });
  const deleteInFlightRef = useRef(false);
  const [optimisticDeletedTaskIds, setOptimisticDeletedTaskIds] = useState(
    () => new Set(),
  );
  const [optimisticDeletedGroupIds, setOptimisticDeletedGroupIds] = useState(
    () => new Set(),
  );

  const fetchDashboardData = useCallback(async ({ includeAI = false } = {}) => {
    const rankingParams = new URLSearchParams({
      includeAI: String(includeAI),
      ...(includeAI && { force: "true" }),
    }).toString();
    const [employeeRes, rankingRes] = await Promise.allSettled([
      getWithRetry("/employees", { fallbackValue: { data: [] } }),
      getWithRetry(`/productivity/rankings?${rankingParams}`, {
        fallbackValue: {
          data: {
            leaderboard: [],
            summary: {
              totalTasks: 0,
              completionRate: 0,
              productivityScore: 0,
              averageCompletionTimeMinutes: 0,
            },
            aiInsights: null,
          },
        },
      }),
    ]);

    const employeesPayload =
      employeeRes.status === "fulfilled" ? employeeRes.value.data || [] : [];
    const rankingPayload =
      rankingRes.status === "fulfilled"
        ? rankingRes.value.data || {
            leaderboard: [],
            summary: {
              totalTasks: 0,
              completionRate: 0,
              productivityScore: 0,
              averageCompletionTimeMinutes: 0,
            },
            aiInsights: null,
          }
        : {
            leaderboard: [],
            summary: {
              totalTasks: 0,
              completionRate: 0,
              productivityScore: 0,
              averageCompletionTimeMinutes: 0,
            },
            aiInsights: null,
          };

    setEmployees(employeesPayload);
    setLeaderboardData((prev) => ({
      ...rankingPayload,
      aiInsights: includeAI
        ? rankingPayload.aiInsights
        : (rankingPayload.aiInsights ?? prev.aiInsights),
      aiStatus: includeAI
        ? rankingPayload.aiStatus
        : (rankingPayload.aiStatus ?? prev.aiStatus),
      insightEngine: includeAI
        ? rankingPayload.insightEngine
        : (rankingPayload.insightEngine ?? prev.insightEngine),
    }));

    if (!employeesPayload.length) {
      setError("No employee data available right now.");
    } else {
      setError("");
    }
    setLastSync(new Date());
  }, []);

  const refreshAiInsights = useCallback(async () => {
    if (aiRequestInFlightRef.current) {
      return;
    }

    aiRequestInFlightRef.current = true;
    setAiLoading(true);
    try {
      await fetchDashboardData({ includeAI: true });
    } finally {
      setAiLoading(false);
      aiRequestInFlightRef.current = false;
    }
  }, [fetchDashboardData]);

  const scheduleAiRefresh = useCallback(() => {
    if (aiRefreshTimeoutRef.current) {
      window.clearTimeout(aiRefreshTimeoutRef.current);
    }

    aiRefreshTimeoutRef.current = window.setTimeout(() => {
      refreshAiInsights();
    }, 800);
  }, [refreshAiInsights]);

  useEffect(() => {
    const init = async () => {
      setLoading(true);
      try {
        await fetchDashboardData({ includeAI: false });
      } catch (err) {
        setError(sanitizeApiError(err, "Failed to load admin dashboard."));
      } finally {
        setLoading(false);
      }

      refreshAiInsights();
    };
    init();
  }, [fetchDashboardData, refreshAiInsights]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      fetchDashboardData({ includeAI: false });
    }, 45_000);

    return () => window.clearInterval(intervalId);
  }, [fetchDashboardData]);

  useEffect(() => {
    if (!ENABLE_REALTIME) {
      return undefined;
    }

    const socket = getSocket();

    const onEmployeeUpdated = ({ email, employee }) => {
      if (!employee) return;
      setEmployees((prev) => prev.map((row) => (row.email === email ? employee : row)));
    };

    const onTaskCreated = ({ email, task }) => {
      if (!email || !task) return;
      setEmployees((prev) =>
        prev.map((row) => (row.email === email ? { ...row, tasks: [...(row.tasks || []), task] } : row)),
      );
    };

    const onTaskStatusChanged = ({ email, employee }) => {
      if (!employee || !email) return;
      setEmployees((prev) => prev.map((row) => (row.email === email ? employee : row)));
    };

    const onTaskActionCompleted = ({ email, employee }) => {
      if (!employee || !email) return;
      setEmployees((prev) => prev.map((row) => (row.email === email ? employee : row)));
    };

    if (socket) {
      socket.on("employeeUpdated", onEmployeeUpdated);
      socket.on("taskCreated", onTaskCreated);
      socket.on("taskStatusChanged", onTaskStatusChanged);
      socket.on("taskActionCompleted", onTaskActionCompleted);
    }

    return () => {
      if (socket) {
        socket.off("employeeUpdated", onEmployeeUpdated);
        socket.off("taskCreated", onTaskCreated);
        socket.off("taskStatusChanged", onTaskStatusChanged);
        socket.off("taskActionCompleted", onTaskActionCompleted);
      }
    };
  }, []);

  useEffect(() => {
    return () => {
      if (aiRefreshTimeoutRef.current) {
        window.clearTimeout(aiRefreshTimeoutRef.current);
      }
    };
  }, []);

  const rankingByEmail = useMemo(
    () =>
      new Map(
        (leaderboardData.leaderboard || []).map((row) => [row.email, row]),
      ),
    [leaderboardData.leaderboard],
  );

  const employeeCards = useMemo(() => {
    return employees.map((employee) => {
      const ranking = rankingByEmail.get(employee.email);
      const stats = ranking?.stats || {};
      const visibleTasks = (employee.tasks || []).filter(
        (task) => !task.isDeleted && !task.notAccepted,
      );
      const latestTasks = [...visibleTasks]
        .sort(
          (a, b) => getTaskActivityTimestamp(b) - getTaskActivityTimestamp(a),
        )
        .slice(0, 3)
        .map((task) => {
          const whenTs = getTaskActivityTimestamp(task);
          const whenText =
            whenTs > 0
              ? new Date(whenTs).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                })
              : "recently";
          if (task.completed) return `${task.taskTitle} completed`;
          if (task.failed) return `${task.taskTitle} failed on ${whenText}`;
          if (task.active) return `${task.taskTitle} in progress (${whenText})`;
          return `${task.taskTitle} assigned on ${whenText}`;
        });

      const cardFallback = deriveCardSignalFallback(stats);
      const workloadStatus = getWorkloadStatus({
        employee,
        ranking,
        stats,
      });

      return {
        ...employee,
        ranking,
        visibleTasks,
        latestTasks,
        completedCount: Number(stats.completedTaskCount) || 0,
        failedCount: Number(stats.failedTaskCount) || 0,
        activeCount:
          Number(stats.activeTaskCount) ||
          Number(employee.taskCounts?.active) ||
          0,
        newCount: Number(employee.taskCounts?.newTask) || 0,
        trendMeta: getTrendMeta(stats),
        workloadStatus,
        strengthTags: deriveStrengthTags({ ranking }),
        cardSignalFallback: cardFallback,
      };
    });
  }, [employees, rankingByEmail]);

  const adminKpis = useMemo(
    () =>
      leaderboardData.summary || {
        totalTasks: 0,
        completionRate: 0,
        productivityScore: 0,
        averageCompletionTimeMinutes: 0,
      },
    [leaderboardData.summary],
  );

  const sortedLeaderboard = useMemo(
    () =>
      [...(leaderboardData.leaderboard || [])].sort(
        (a, b) => b.productivityScore - a.productivityScore,
      ),
    [leaderboardData.leaderboard],
  );

  const topPerformer = sortedLeaderboard[0] || null;
  const lowPerformer =
    sortedLeaderboard.length > 0
      ? sortedLeaderboard[sortedLeaderboard.length - 1]
      : null;

  const aiEmployeeSignalsByEmail = useMemo(() => {
    const rows = Array.isArray(leaderboardData.aiInsights?.employeeInsights)
      ? leaderboardData.aiInsights.employeeInsights
      : [];
    return new Map(
      rows
        .map((row) => [
          String(row.email || "")
            .trim()
            .toLowerCase(),
          row,
        ])
        .filter(([email]) => Boolean(email)),
    );
  }, [leaderboardData.aiInsights]);

  const chatTasks = useMemo(() => {
    return employees.flatMap((employee) =>
      (employee.tasks || []).map((task) => ({
        ...task,
        ownerEmail: employee.email,
        ownerName: [employee.firstName, employee.lastName]
          .filter(Boolean)
          .join(" "),
      })),
    );
  }, [employees]);

  const comparisonRows = useMemo(() => {
    const maxScore = Math.max(
      ...sortedLeaderboard.map((entry) => Number(entry.productivityScore) || 0),
      1,
    );

    return sortedLeaderboard.map((entry) => {
      const completed = Number(entry?.stats?.completedTaskCount) || 0;
      const failed = Number(entry?.stats?.failedTaskCount) || 0;
      const totalOutcomes = completed + failed;
      return {
        ...entry,
        trendMeta: getTrendMeta(entry.stats || {}),
        completed,
        failed,
        totalOutcomes,
        completionRateFromOutcomes: toPercent(completed, totalOutcomes),
        scorePercent: Number(
          ((Number(entry.productivityScore || 0) / maxScore) * 100).toFixed(1),
        ),
      };
    });
  }, [sortedLeaderboard]);

  const teamOutcomeBreakdown = useMemo(() => {
    const completed = sortedLeaderboard.reduce(
      (sum, entry) => sum + (Number(entry?.stats?.completedTaskCount) || 0),
      0,
    );
    const failed = sortedLeaderboard.reduce(
      (sum, entry) => sum + (Number(entry?.stats?.failedTaskCount) || 0),
      0,
    );
    const active = sortedLeaderboard.reduce(
      (sum, entry) => sum + (Number(entry?.stats?.activeTaskCount) || 0),
      0,
    );
    const pending = employeeCards.reduce(
      (sum, employee) => sum + (Number(employee.newCount) || 0),
      0,
    );

    const total = completed + failed + active + pending;
    const completionRate = toPercent(completed, completed + failed);

    let teamCondition = "Stable";
    if (completionRate >= 75 && failed <= completed * 0.25) {
      teamCondition = "Healthy";
    } else if (completionRate < 55 || failed > completed * 0.6) {
      teamCondition = "Needs Intervention";
    }

    return {
      completed,
      failed,
      active,
      pending,
      total,
      completionRate,
      teamCondition,
    };
  }, [employeeCards, sortedLeaderboard]);

  const handleDeleteSingleTask = async (task) => {
    if (!task?.employeeEmail) return;
    const confirmed = window.confirm(
      `Delete "${task.taskTitle}" for ${task.employeeName}? This hides the task for the employee while preserving analytics.`,
    );
    if (!confirmed) return;
    if (deleteInFlightRef.current) return;
    deleteInFlightRef.current = true;
    if (task.taskId) {
      setOptimisticDeletedTaskIds((prev) => {
        const next = new Set(prev);
        next.add(String(task.taskId));
        return next;
      });
    }
    try {
      if (task.taskId) {
        await axios.post(
          `${API_URL}/employees/${task.employeeEmail}/tasks/${task.taskId}/delete`,
        );
      } else {
        const res = await axios.get(
          `${API_URL}/employees/${task.employeeEmail}`,
        );
        const employee = res.data;
        const taskIndex = (employee.tasks || []).findIndex(
          (candidate) =>
            candidate.taskTitle === task.taskTitle &&
            candidate.taskDate === task.taskDate &&
            candidate.taskDescription === task.taskDescription &&
            !candidate.isDeleted,
        );
        if (taskIndex === -1) return;
        const updatedTasks = [...employee.tasks];
        updatedTasks[taskIndex] = {
          ...updatedTasks[taskIndex],
          isDeleted: true,
          deletedAt: new Date(),
        };
        const updatedEmployee = {
          ...employee,
          tasks: updatedTasks,
          taskCounts: employee.taskCounts || {},
        };
        await axios.put(
          `${API_URL}/employees/${employee.email}`,
          updatedEmployee,
        );
      }

      await fetchDashboardData({ includeAI: false });
      scheduleAiRefresh();
    } catch (err) {
      console.error("Delete task failed:", err);
      window.alert("Unable to delete task right now. Please retry.");
      if (task.taskId) {
        setOptimisticDeletedTaskIds((prev) => {
          const next = new Set(prev);
          next.delete(String(task.taskId));
          return next;
        });
      }
    } finally {
      deleteInFlightRef.current = false;
    }
  };

  const handleDeleteGroupTask = async (task) => {
    if (!task?.groupId) return;
    const confirmed = window.confirm(
      `Delete group task "${task.taskTitle}" for all members? This hides the task but preserves analytics.`,
    );
    if (!confirmed) return;
    if (deleteInFlightRef.current) return;
    deleteInFlightRef.current = true;
    setOptimisticDeletedGroupIds((prev) => {
      const next = new Set(prev);
      next.add(task.groupId);
      return next;
    });
    try {
      await axios.post(`${API_URL}/group-tasks/${task.groupId}/delete`);
      await fetchDashboardData({ includeAI: false });
      scheduleAiRefresh();
    } catch (err) {
      console.error("Delete group task failed:", err);
      window.alert("Unable to delete group task right now. Please retry.");
      setOptimisticDeletedGroupIds((prev) => {
        const next = new Set(prev);
        next.delete(task.groupId);
        return next;
      });
    } finally {
      deleteInFlightRef.current = false;
    }
  };

  const promptExtensionMinutes = (label) => {
    const hoursRaw = window.prompt(
      `Extend by hours${label ? ` for ${label}` : ""}?`,
    );
    if (hoursRaw === null) return null;
    const minutesRaw = window.prompt(
      `Extend by minutes${label ? ` for ${label}` : ""}?`,
    );
    if (minutesRaw === null) return null;

    const hours = Number(hoursRaw || 0);
    const minutes = Number(minutesRaw || 0);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
      window.alert("Please enter valid numbers for hours and minutes.");
      return null;
    }
    const totalMinutes = hours * 60 + minutes;
    if (totalMinutes <= 0) {
      window.alert("Please enter a time greater than 0.");
      return null;
    }
    return totalMinutes;
  };

  const addDaysToTaskDateLocal = (taskDate, days) => {
    if (!taskDate) return taskDate;
    const parsed = new Date(taskDate);
    if (Number.isNaN(parsed.getTime())) return taskDate;
    const next = new Date(parsed);
    next.setDate(next.getDate() + days);
    return next.toISOString().slice(0, 10);
  };

  const handleExtendSingleTask = async (task) => {
    if (!task?.taskId || !task?.employeeEmail) return;
    const totalMinutes = promptExtensionMinutes(task.taskTitle);
    if (!totalMinutes) return;
    const days = totalMinutes / (24 * 60);
    try {
      await axios.post(
        `${API_URL}/employees/${task.employeeEmail}/tasks/${task.taskId}/extend`,
        { days },
      );
      const addedMinutes = Math.round(totalMinutes);
      const nowIso = new Date().toISOString();
      setEmployees((prev) =>
        prev.map((employee) => {
          if (employee.email !== task.employeeEmail) return employee;
          const tasks = (employee.tasks || []).map((entry) => {
            const entryId = entry._id || entry.taskId;
            if (String(entryId) !== String(task.taskId)) return entry;
            const updated = { ...entry };
            updated.estimatedDuration = Math.max(
              0,
              Number(updated.estimatedDuration || 0) + addedMinutes,
            );
            const nextDate = addDaysToTaskDateLocal(updated.taskDate, days);
            if (nextDate) {
              updated.taskDate = nextDate;
            }
            if (updated.failed) {
              updated.failed = false;
              updated.completed = false;
              updated.active = true;
              updated.completedAt = null;
              updated.startedAt = nowIso;
            }
            return updated;
          });
          return { ...employee, tasks };
        }),
      );
      await axios.post(
        `${API_URL}/employees/${task.employeeEmail}/tasks/${task.taskId}/chat/messages`,
        {
          senderName: "System",
          senderEmail: "system",
          senderRole: "system",
          message: "Task deadline extended and reactivated by admin",
          type: "system",
        },
      );
    } catch (err) {
      console.error("Extend task failed:", err);
      window.alert("Unable to extend task right now. Please retry.");
    }
  };

  const handleExtendGroupTask = async (task) => {
    if (!task?.groupId) return;
    const totalMinutes = promptExtensionMinutes(task.taskTitle);
    if (!totalMinutes) return;
    const days = totalMinutes / (24 * 60);
    try {
      await axios.post(`${API_URL}/group-tasks/${task.groupId}/extend`, {
        days,
      });
      const addedMinutes = Math.round(totalMinutes);
      const nowIso = new Date().toISOString();
      setEmployees((prev) =>
        prev.map((employee) => {
          const tasks = (employee.tasks || []).map((entry) => {
            if (entry.groupId !== task.groupId) return entry;
            const updated = { ...entry };
            updated.estimatedDuration = Math.max(
              0,
              Number(updated.estimatedDuration || 0) + addedMinutes,
            );
            const nextDate = addDaysToTaskDateLocal(updated.taskDate, days);
            if (nextDate) {
              updated.taskDate = nextDate;
            }
            if (Array.isArray(updated.groupMemberEstimates)) {
              updated.groupMemberEstimates = updated.groupMemberEstimates.map(
                (member) => ({
                  ...member,
                  estimatedMinutes: Math.max(
                    0,
                    Number(member.estimatedMinutes || 0) + addedMinutes,
                  ),
                }),
              );
            }
            if (updated.failed) {
              updated.failed = false;
              updated.completed = false;
              updated.active = true;
              updated.completedAt = null;
              updated.startedAt = nowIso;
            }
            return updated;
          });
          return { ...employee, tasks };
        }),
      );
      await axios.post(`${API_URL}/group-tasks/${task.groupId}/chat/messages`, {
        senderName: "System",
        senderEmail: "system",
        senderRole: "system",
        message: "Task deadline extended and reactivated by admin",
        type: "system",
      });
    } catch (err) {
      console.error("Extend group task failed:", err);
      window.alert("Unable to extend group task right now. Please retry.");
    }
  };

  const handleExtendGroupMember = async (task, member) => {
    if (!task?.groupId || !member?.email) return;
    const totalMinutes = promptExtensionMinutes(member.name || member.email);
    if (!totalMinutes) return;
    const days = totalMinutes / (24 * 60);
    try {
      await axios.post(`${API_URL}/group-tasks/${task.groupId}/extend`, {
        days,
        memberEmail: member.email,
      });
      const addedMinutes = Math.round(totalMinutes);
      const nowIso = new Date().toISOString();
      const memberEmail = String(member.email || "").toLowerCase();
      setEmployees((prev) =>
        prev.map((employee) => {
          const empEmail = String(employee.email || "").toLowerCase();
          const tasks = (employee.tasks || []).map((entry) => {
            if (entry.groupId !== task.groupId) return entry;
            if (!Array.isArray(entry.groupMemberEstimates)) return entry;
            const updated = { ...entry };
            const wasFailed = Boolean(entry.failed);
            updated.groupMemberEstimates = entry.groupMemberEstimates.map(
              (estimate) => {
                if (
                  String(estimate?.email || "").toLowerCase() !== memberEmail
                ) {
                  return estimate;
                }
                return {
                  ...estimate,
                  estimatedMinutes: Math.max(
                    0,
                    Number(estimate.estimatedMinutes || 0) + addedMinutes,
                  ),
                };
              },
            );
            if (empEmail === memberEmail && wasFailed) {
              const row = updated.groupMemberEstimates.find(
                (e) =>
                  String(e?.email || "").toLowerCase() === memberEmail,
              );
              const mins = Number(row?.estimatedMinutes);
              if (Number.isFinite(mins) && mins > 0) {
                updated.estimatedDuration = Math.round(mins);
              }
              updated.failed = false;
              updated.completed = false;
              updated.active = true;
              updated.completedAt = null;
              updated.startedAt = nowIso;
            }
            return updated;
          });
          return { ...employee, tasks };
        }),
      );
      await axios.post(`${API_URL}/group-tasks/${task.groupId}/chat/messages`, {
        senderName: "System",
        senderEmail: "system",
        senderRole: "system",
        message: "Task deadline extended and reactivated by admin",
        type: "system",
      });
    } catch (err) {
      console.error("Extend member task failed:", err);
      window.alert("Unable to extend member duration right now. Please retry.");
    }
  };

  const taskMonitoringData = useMemo(() => {
    const nowMs = Date.now();
    const singleTasks = [];
    const groupMap = new Map();
    const employeeNameByEmail = new Map(
      employees.map((employee) => [
        String(employee.email || "").toLowerCase(),
        [employee.firstName, employee.lastName].filter(Boolean).join(" ") ||
          employee.email ||
          "Employee",
      ]),
    );

    const ensureGroupEntry = (task) => {
      if (!task?.groupId) return null;
      if (!groupMap.has(task.groupId)) {
        groupMap.set(task.groupId, {
          groupId: task.groupId,
          taskTitle: task.taskTitle,
          taskDate: task.taskDate,
          category: task.category,
          groupMembers: Array.isArray(task.groupMembers)
            ? task.groupMembers
            : [],
          assignments: Array.isArray(task.groupStepAssignments)
            ? task.groupStepAssignments
            : [],
          groupMemberEstimates: Array.isArray(task.groupMemberEstimates)
            ? task.groupMemberEstimates
            : [],
          estimatedDuration: Number(task.estimatedDuration) || 0,
          explainEstimatedTime: task.explainEstimatedTime,
          groupAcceptedEmails: Array.isArray(task.groupAcceptedEmails)
            ? task.groupAcceptedEmails
            : [],
          tasksByEmail: new Map(),
        });
      }
      return groupMap.get(task.groupId);
    };

    employees.forEach((employee) => {
      (employee.tasks || []).forEach((task) => {
        if (task?.isDeleted) return;
        if (task?._id && optimisticDeletedTaskIds.has(String(task._id))) {
          return;
        }
        if (task?.groupId && optimisticDeletedGroupIds.has(task.groupId)) {
          return;
        }

        if (task?.groupTask && task?.groupId) {
          if (task?.completed && !task?.failed) return;
          const entry = ensureGroupEntry(task);
          if (!entry) return;
          entry.tasksByEmail.set(
            String(employee.email || "").toLowerCase(),
            task,
          );
          if (!entry.groupMembers.length && Array.isArray(task.groupMembers)) {
            entry.groupMembers = task.groupMembers;
          }
          if (
            !entry.assignments.length &&
            Array.isArray(task.groupStepAssignments)
          ) {
            entry.assignments = task.groupStepAssignments;
          }
          if (
            !entry.groupMemberEstimates.length &&
            Array.isArray(task.groupMemberEstimates)
          ) {
            entry.groupMemberEstimates = task.groupMemberEstimates;
          }
          if (!entry.estimatedDuration && Number(task.estimatedDuration) > 0) {
            entry.estimatedDuration = Number(task.estimatedDuration);
          }
          if (!entry.explainEstimatedTime && task.explainEstimatedTime) {
            entry.explainEstimatedTime = task.explainEstimatedTime;
          }
          if (
            (!entry.groupAcceptedEmails ||
              entry.groupAcceptedEmails.length === 0) &&
            Array.isArray(task.groupAcceptedEmails)
          ) {
            entry.groupAcceptedEmails = task.groupAcceptedEmails;
          }
          return;
        }

        const isPending = Boolean(task?.notAccepted || task?.newTask);
        if (task?.active && !task?.completed && !task?.failed) {
          const estimatedMinutes =
            Number(task.estimatedDuration) ||
            parseDurationMinutes(task.explainEstimatedTime);
          const startMs = getTaskStartMs(task);
          const totalMs =
            estimatedMinutes > 0 ? estimatedMinutes * 60 * 1000 : 0;
          const elapsedMs = startMs ? Math.max(0, nowMs - startMs) : 0;
          const remainingMs =
            totalMs > 0 && startMs ? totalMs - elapsedMs : null;
          const steps = Array.isArray(task.explainSteps)
            ? task.explainSteps
            : [];
          const stepChecks = Array.isArray(task.explainStepChecks)
            ? task.explainStepChecks
            : [];
          const completedSteps = steps.length
            ? stepChecks.filter(Boolean).length
            : 0;
          const stepProgressPercent = steps.length
            ? Math.round((completedSteps / steps.length) * 100)
            : null;
          const timeProgressPercent =
            totalMs > 0 && startMs
              ? Math.min(100, Math.round((elapsedMs / totalMs) * 100))
              : 0;
          const progressPercent =
            stepProgressPercent !== null
              ? stepProgressPercent
              : timeProgressPercent;

          const isOverdue = remainingMs !== null && remainingMs < 0;
          const statusLabel = isOverdue ? "Failed" : "Active";
          const displayProgressPercent =
            statusLabel === "Failed" ? 0 : progressPercent;
          singleTasks.push({
            id: task._id || `${task.taskTitle}-${task.taskDate}`,
            taskId: task._id,
            employeeEmail: employee.email,
            employeeName:
              employeeNameByEmail.get(
                String(employee.email || "").toLowerCase(),
              ) || "Employee",
            taskTitle: task.taskTitle,
            taskDate: task.taskDate,
            taskDescription: task.taskDescription,
            steps,
            completedSteps,
            totalSteps: steps.length,
            progressPercent,
            displayProgressPercent,
            remainingMs,
            estimatedMinutes,
            statusLabel,
            updatedAt: task.completedAt || task.submittedAt || task.startedAt,
          });
        } else if (isPending && !task?.completed && !task?.failed) {
          const steps = Array.isArray(task.explainSteps)
            ? task.explainSteps
            : [];
          const stepChecks = Array.isArray(task.explainStepChecks)
            ? task.explainStepChecks
            : [];
          const completedSteps = steps.length
            ? stepChecks.filter(Boolean).length
            : 0;
          const progressPercent = steps.length
            ? Math.round((completedSteps / steps.length) * 100)
            : 0;
          singleTasks.push({
            id: task._id || `${task.taskTitle}-${task.taskDate}`,
            taskId: task._id,
            employeeEmail: employee.email,
            employeeName:
              employeeNameByEmail.get(
                String(employee.email || "").toLowerCase(),
              ) || "Employee",
            taskTitle: task.taskTitle,
            taskDate: task.taskDate,
            taskDescription: task.taskDescription,
            steps,
            completedSteps,
            totalSteps: steps.length,
            progressPercent,
            remainingMs: null,
            estimatedMinutes: Number(task.estimatedDuration) || 0,
            statusLabel: "Awaiting Acceptance",
            updatedAt: task.assignedAt || task.createdAt || task.taskDate,
          });
        }
      });
    });

    const groupTasks = Array.from(groupMap.values())
      .map((entry) => {
        const assignments = Array.isArray(entry.assignments)
          ? entry.assignments
          : [];
        const totalSteps = assignments.length;
        const completedSteps = assignments.filter(
          (step) => step.completed,
        ).length;
        const overallPercent =
          totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0;
        const members = (entry.groupMembers || []).map((member) => {
          const email = String(member.email || "").toLowerCase();
          const memberAssignments = assignments.filter(
            (step) => String(step.assignedEmail || "").toLowerCase() === email,
          );
          const memberCompleted = memberAssignments.filter(
            (step) => step.completed,
          ).length;
          const memberPercent =
            memberAssignments.length > 0
              ? Math.round((memberCompleted / memberAssignments.length) * 100)
              : 0;
          const memberTask = entry.tasksByEmail.get(email);
          const memberStartMs = getTaskStartMs(memberTask || {});
          const memberEstimate =
            Number(
              entry.groupMemberEstimates.find(
                (item) => String(item?.email || "").toLowerCase() === email,
              )?.estimatedMinutes,
            ) ||
            (entry.estimatedDuration > 0 && entry.groupMembers.length > 0
              ? Math.max(
                  1,
                  Math.round(
                    entry.estimatedDuration / entry.groupMembers.length,
                  ),
                )
              : parseDurationMinutes(entry.explainEstimatedTime));
          const memberTotalMs =
            memberEstimate > 0 ? memberEstimate * 60 * 1000 : 0;
          const memberRemainingMs =
            memberTotalMs > 0 && memberStartMs
              ? memberTotalMs - Math.max(0, nowMs - memberStartMs)
              : null;
          const memberTaskFailed = Boolean(memberTask?.failed);

          return {
            email,
            name:
              member.name ||
              employeeNameByEmail.get(email) ||
              member.email ||
              "Employee",
            assignments: memberAssignments,
            completedCount: memberCompleted,
            percent: memberPercent,
            displayPercent: memberTaskFailed ? 0 : memberPercent,
            remainingMs: memberRemainingMs,
            estimatedMinutes: memberEstimate,
            taskFailed: memberTaskFailed,
          };
        });

        const awaitingGroupAcceptance =
          (entry.groupAcceptedEmails || []).length === 0;
        const memberTaskStates = Array.from(entry.tasksByEmail.values());
        const allCompleted =
          memberTaskStates.length > 0 &&
          memberTaskStates.every((task) => task?.completed && !task?.failed);
        const hasFailed = memberTaskStates.some((task) => task?.failed);
        const remainingCandidates = members
          .map((member) => member.remainingMs)
          .filter((value) => typeof value === "number");
        const overallRemainingMs = remainingCandidates.length
          ? Math.max(...remainingCandidates)
          : null;
        const isOverdue = overallRemainingMs !== null && overallRemainingMs < 0;
        const displayOverallPercent = hasFailed ? 0 : overallPercent;

        return {
          groupId: entry.groupId,
          taskTitle: entry.taskTitle,
          taskDate: entry.taskDate,
          category: entry.category,
          totalSteps,
          completedSteps,
          overallPercent,
          displayOverallPercent,
          members,
          overallRemainingMs,
          groupAcceptedEmails: entry.groupAcceptedEmails,
          hasFailed,
          allCompleted,
          statusLabel: awaitingGroupAcceptance
            ? "Awaiting Acceptance"
            : hasFailed || isOverdue
              ? "Failed"
              : "Active",
        };
      })
      .filter((entry) => {
        if (entry.allCompleted && !entry.hasFailed) return false;
        if (entry.members.length === 0) return false;
        if ((entry.groupAcceptedEmails || []).length > 0) return true;
        return entry.members.some((member) => member.assignments.length > 0);
      });

    return {
      nowMs,
      singleTasks,
      groupTasks,
    };
  }, [
    employees,
    lastSync,
    optimisticDeletedTaskIds,
    optimisticDeletedGroupIds,
  ]);

  const fallbackRecommendations = useMemo(() => {
    const recommendations = [];

    recommendations.push(
      `Completion rate is ${adminKpis.completionRate}%; focus on moving active tasks into completed status this week.`,
    );

    recommendations.push(
      `Current productivity score is ${adminKpis.productivityScore}; reduce failed-task volume to improve team score faster.`,
    );

    if (topPerformer && lowPerformer) {
      recommendations.push(
        `Use ${topPerformer.name}'s workflow as coaching input for ${lowPerformer.name} to close the performance gap.`,
      );
    }

    return recommendations;
  }, [adminKpis, topPerformer, lowPerformer]);

  const aiSummaryText = useMemo(() => {
    if (leaderboardData.aiInsights?.summary)
      return leaderboardData.aiInsights.summary;
    if (!topPerformer || !lowPerformer) {
      return "Team summary appears as employee activity data grows.";
    }
    return `Team snapshot: ${topPerformer.name} is currently leading, while ${lowPerformer.name} needs additional support.`;
  }, [leaderboardData.aiInsights, topPerformer, lowPerformer]);

  const adminInsightSource = useMemo(() => {
    const engine = leaderboardData.insightEngine;
    if (engine === "ai") return "AI";
    if (engine === "cached") return "AI";
    return "SYS";
  }, [leaderboardData.insightEngine]);

  const adminQuickPills = useMemo(() => {
    const ai = leaderboardData.aiInsights;
    if (!ai) return [];
    if (Array.isArray(ai.recommendationPills) && ai.recommendationPills.length) {
      return ai.recommendationPills;
    }
    return Array.isArray(ai.recommendations) ? ai.recommendations : [];
  }, [leaderboardData.aiInsights]);

  const adminTeamPills = useMemo(() => {
    const ai = leaderboardData.aiInsights;
    if (!ai) return [];
    if (Array.isArray(ai.teamDiagnosticPills) && ai.teamDiagnosticPills.length) {
      return ai.teamDiagnosticPills;
    }
    if (Array.isArray(ai.teamDiagnostics) && ai.teamDiagnostics.length) {
      return ai.teamDiagnostics;
    }
    const legacy = [
      ai.teamPattern,
      ai.workloadImbalance,
      ai.failureClusters,
      ...(ai.underutilizedEmployees || []),
      ...(ai.changeSignals || []),
    ].filter(Boolean);
    return legacy;
  }, [leaderboardData.aiInsights]);

  const handleAddEmployeeInput = (event) => {
    const { name, value } = event.target;
    setAddEmployeeForm((prev) => ({
      ...prev,
      [name]: value,
    }));
  };

  const handleAddEmployee = async (event) => {
    event.preventDefault();
    setAddEmployeeLoading(true);
    setAddEmployeeError("");

    try {
      await postWithRetry("/employees", {
        firstName: addEmployeeForm.firstName,
        lastName: addEmployeeForm.lastName,
        email: addEmployeeForm.email,
        role: addEmployeeForm.role,
      });

      setAddEmployeeForm({
        firstName: "",
        lastName: "",
        email: "",
        role: "employee",
      });
      setShowAddEmployeeForm(false);
      await fetchDashboardData({ includeAI: false });
      scheduleAiRefresh();
    } catch (err) {
      setAddEmployeeError(
        sanitizeApiError(err, "Unable to add employee. Please retry."),
      );
    } finally {
      setAddEmployeeLoading(false);
    }
  };

  const employeeSearchResults = useMemo(() => {
    const query = employeeSearch.trim().toLowerCase();
    if (!query) return employees.slice(0, 5);
    return employees
      .filter((employee) => {
        const name =
          `${employee.firstName || ""} ${employee.lastName || ""}`.toLowerCase();
        const email = String(employee.email || "").toLowerCase();
        return name.includes(query) || email.includes(query);
      })
      .slice(0, 8);
  }, [employeeSearch, employees]);

  const beginEditEmployee = (employee) => {
    setEditingEmployeeEmail(employee.email);
    setEmployeeActionError("");
    setEmployeeActionSuccess("");
    setEditEmployeeForm({
      firstName: employee.firstName || "",
      lastName: employee.lastName || "",
      email: employee.email || "",
      role: employee.role || "employee",
    });
  };

  const handleEditEmployeeInput = (event) => {
    const { name, value } = event.target;
    setEditEmployeeForm((prev) => ({ ...prev, [name]: value }));
  };

  const saveEmployeeEdit = async (event) => {
    event.preventDefault();
    if (!editingEmployeeEmail) return;
    setEmployeeActionError("");
    setEmployeeActionSuccess("");
    try {
      await axios.patch(
        `${API_URL}/employees/${editingEmployeeEmail}/profile`,
        editEmployeeForm,
      );
      setEditingEmployeeEmail("");
      setEmployeeActionSuccess("Employee details updated.");
      await fetchDashboardData({ includeAI: false });
      scheduleAiRefresh();
    } catch (err) {
      setEmployeeActionError(
        sanitizeApiError(err, "Unable to update employee details."),
      );
    }
  };

  const deleteEmployee = async (employee) => {
    const name = [employee.firstName, employee.lastName]
      .filter(Boolean)
      .join(" ");
    const confirmed = window.confirm(
      `Delete employee access for ${name || employee.email}? Historical task data will be preserved.`,
    );
    if (!confirmed) return;
    setEmployeeActionError("");
    setEmployeeActionSuccess("");
    try {
      await axios.delete(`${API_URL}/employees/${employee.email}`);
      setEmployeeActionSuccess(
        "Employee deleted from active dashboard. History is preserved.",
      );
      await fetchDashboardData({ includeAI: false });
      scheduleAiRefresh();
    } catch (err) {
      setEmployeeActionError(
        sanitizeApiError(err, "Unable to delete employee."),
      );
    }
  };

  return (
    <div
      className={
        theme === "dark"
          ? "min-h-screen bg-[#121212] p-2 md:p-8"
          : "min-h-screen bg-[#f4f6fb] p-2 md:p-8"
      }
    >
      <div className="mb-2 flex justify-end">
        <button
          className={
            theme === "dark"
              ? "px-4 py-2 rounded bg-gray-700 text-white flex items-center gap-2"
              : "px-4 py-2 rounded bg-yellow-300 text-black flex items-center gap-2"
          }
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        >
          <span>{theme === "dark" ? "🌙" : "☀️"}</span>
          <span className="font-semibold">
            {theme === "dark" ? "Dark" : "Light"} Mode
          </span>
        </button>
      </div>

      <Header theme={theme} showSectionNav={false} />

      <section className="mx-auto mt-6 w-full max-w-[1400px] space-y-5">
        <section
          className={`rounded-2xl border p-4 md:p-5 ${theme === "dark" ? "border-cyan-400/20 bg-gradient-to-r from-cyan-500/10 to-blue-500/10 text-white" : "border-cyan-100 bg-white text-gray-900"}`}
        >
          <p className="text-xs uppercase tracking-wider opacity-70">
            Top Summary
          </p>
          <h2 className="mt-1 text-xl font-semibold md:text-2xl">
            {aiSummaryText}
          </h2>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs opacity-80">
            <span>Last Sync Time: {formatSyncTime(lastSync)}</span>
            <span>•</span>
            <span>
              {aiLoading
                ? "Refreshing AI insights..."
                : leaderboardData.insightEngine === "ai"
                  ? "AI insights ready"
                  : "Showing data-driven insights"}
            </span>
            <span>•</span>
            <span>
              Team condition:{" "}
              <strong>{teamOutcomeBreakdown.teamCondition}</strong>
            </span>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <SummaryCard
              label="Total Tasks"
              value={adminKpis.totalTasks}
              theme={theme}
            />
            <SummaryCard
              label="Completion Rate"
              value={`${adminKpis.completionRate}%`}
              theme={theme}
            />
            <SummaryCard
              label="Productivity Score"
              value={adminKpis.productivityScore}
              theme={theme}
            />
            <SummaryCard
              label="Avg Completion Time"
              value={`${adminKpis.averageCompletionTimeMinutes} min`}
              theme={theme}
            />
            <SummaryCard
              label="Completed Outcomes"
              value={teamOutcomeBreakdown.completed}
              theme={theme}
            />
            <SummaryCard
              label="Active Employees"
              value={employeeCards.length}
              theme={theme}
            />
          </div>
        </section>

        <TaskMonitoringPanel
          theme={theme}
          data={taskMonitoringData}
          loading={loading}
          onDeleteSingle={handleDeleteSingleTask}
          onDeleteGroup={handleDeleteGroupTask}
          onExtendSingle={handleExtendSingleTask}
          onExtendGroup={handleExtendGroupTask}
          onExtendMember={handleExtendGroupMember}
        />

        <section className="grid grid-cols-1 gap-4 xl:grid-cols-3">
          <div
            className={`rounded-xl border p-4 xl:col-span-2 ${theme === "dark" ? "border-white/10 bg-[#181818] text-white" : "border-gray-200 bg-white text-gray-900"}`}
          >
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold">Visual Comparison</h3>
                <p className="text-[11px] opacity-70">
                  Performance bars compare score, completion outcomes, and pace.
                </p>
              </div>
            </div>

            <div className="mt-3 max-h-[320px] space-y-2 overflow-y-auto pr-1">
              {comparisonRows.length === 0 ? (
                <p className="text-xs opacity-70">No ranking data yet.</p>
              ) : (
                comparisonRows.map((row, idx) => (
                  <article
                    key={row.employeeId || row.email}
                    className={`rounded-lg border p-2.5 ${theme === "dark" ? "border-white/10 bg-white/5" : "border-gray-200 bg-gray-50"}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold">
                          #{idx + 1} {row.name}
                        </p>
                        <p className="text-[11px] opacity-70">{row.email}</p>
                      </div>
                      <span
                        className={`rounded-full px-2 py-1 text-[10px] font-semibold ${row.trendMeta.className}`}
                      >
                        {row.trendMeta.icon} {row.trendMeta.label}
                      </span>
                    </div>

                    <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-black/20">
                      <div
                        className="h-full rounded-full bg-cyan-400"
                        style={{ width: `${Math.max(6, row.scorePercent)}%` }}
                      />
                    </div>

                    <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] md:grid-cols-4">
                      <StatPill
                        theme={theme}
                        label="Score"
                        value={row.productivityScore.toFixed(1)}
                      />
                      <StatPill
                        theme={theme}
                        label="Completion"
                        value={`${row.completionRateFromOutcomes}%`}
                      />
                      <StatPill
                        theme={theme}
                        label="Avg Time"
                        value={`${row.stats.averageCompletionTimeMinutes} min`}
                      />
                      <StatPill
                        theme={theme}
                        label="Outcomes"
                        value={`${row.completed}/${row.totalOutcomes}`}
                      />
                    </div>
                  </article>
                ))
              )}
            </div>
          </div>

          <div
            className={`rounded-xl border p-4 ${theme === "dark" ? "border-white/10 bg-[#181818] text-white" : "border-gray-200 bg-white text-gray-900"}`}
          >
            <h3 className="text-sm font-semibold">Team-Level Overview</h3>
            <p className="mt-1 text-[11px] opacity-70">
              Overall completion quality and workload distribution.
            </p>

            <div className="mt-3 rounded-lg border border-white/10 bg-black/10 p-3">
              <p className="text-[11px] opacity-70">Team completion rate</p>
              <p className="text-lg font-semibold">
                {teamOutcomeBreakdown.completionRate}%
              </p>
              <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-black/20">
                <div
                  className="h-full rounded-full bg-emerald-400"
                  style={{
                    width: `${Math.max(4, teamOutcomeBreakdown.completionRate)}%`,
                  }}
                />
              </div>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
              <StatPill
                theme={theme}
                label="Completed"
                value={teamOutcomeBreakdown.completed}
              />
              <StatPill
                theme={theme}
                label="Failed"
                value={teamOutcomeBreakdown.failed}
              />
              <StatPill
                theme={theme}
                label="Active"
                value={teamOutcomeBreakdown.active}
              />
              <StatPill
                theme={theme}
                label="Pending"
                value={teamOutcomeBreakdown.pending}
              />
            </div>

            <p className="mt-3 text-xs opacity-80">
              Condition: <strong>{teamOutcomeBreakdown.teamCondition}</strong> —
              based on completion outcomes, failure load, and active workload
              ratio.
            </p>
          </div>
        </section>

        <section className="grid grid-cols-1 gap-4 xl:grid-cols-3">
          <div
            className={`rounded-xl border p-4 xl:col-span-2 ${theme === "dark" ? "border-white/10 bg-[#181818] text-white" : "border-gray-200 bg-white text-gray-900"}`}
          >
            <h3 className="text-sm font-semibold">Task Assignment</h3>
            <div className="mt-3">
              <CreateTask
                theme={theme}
                employees={employees}
                onTaskCreated={fetchDashboardData}
              />
            </div>
          </div>

          <div
            className={`rounded-xl border p-4 ${theme === "dark" ? "border-white/10 bg-[#181818] text-white" : "border-gray-200 bg-white text-gray-900"}`}
          >
            <button
              type="button"
              className={`w-full rounded-lg border px-3 py-2 text-sm font-semibold ${theme === "dark" ? "border-cyan-300/40 bg-cyan-500/10 text-cyan-300" : "border-cyan-200 bg-cyan-50 text-cyan-700"}`}
              onClick={() => setShowAddEmployeeForm((prev) => !prev)}
            >
              {showAddEmployeeForm ? "Hide Add Employee" : "Add Employee"}
            </button>

            {showAddEmployeeForm && (
              <form
                onSubmit={handleAddEmployee}
                className={`mt-3 space-y-2 rounded-lg border p-3 ${theme === "dark" ? "border-white/10 bg-black/20" : "border-gray-200 bg-gray-50"}`}
              >
                <input
                  name="firstName"
                  value={addEmployeeForm.firstName}
                  onChange={handleAddEmployeeInput}
                  placeholder="First name"
                  required
                  className={`w-full rounded-md border px-2 py-2 text-sm ${theme === "dark" ? "border-white/10 bg-[#0f0f0f]" : "border-gray-200 bg-white"}`}
                />
                <input
                  name="lastName"
                  value={addEmployeeForm.lastName}
                  onChange={handleAddEmployeeInput}
                  placeholder="Last name (optional)"
                  className={`w-full rounded-md border px-2 py-2 text-sm ${theme === "dark" ? "border-white/10 bg-[#0f0f0f]" : "border-gray-200 bg-white"}`}
                />
                <input
                  name="email"
                  type="email"
                  value={addEmployeeForm.email}
                  onChange={handleAddEmployeeInput}
                  placeholder="Work email"
                  required
                  className={`w-full rounded-md border px-2 py-2 text-sm ${theme === "dark" ? "border-white/10 bg-[#0f0f0f]" : "border-gray-200 bg-white"}`}
                />
                <input
                  name="role"
                  value={addEmployeeForm.role}
                  onChange={handleAddEmployeeInput}
                  placeholder="Role"
                  className={`w-full rounded-md border px-2 py-2 text-sm ${theme === "dark" ? "border-white/10 bg-[#0f0f0f]" : "border-gray-200 bg-white"}`}
                />

                {addEmployeeError && (
                  <p className="text-xs text-red-400">{addEmployeeError}</p>
                )}

                <button
                  type="submit"
                  disabled={addEmployeeLoading}
                  className={`w-full rounded-md px-3 py-2 text-sm font-semibold ${theme === "dark" ? "bg-cyan-500/20 text-cyan-300" : "bg-cyan-100 text-cyan-800"}`}
                >
                  {addEmployeeLoading ? "Creating..." : "Create Employee"}
                </button>
                <p className="text-[11px] opacity-70">
                  Account is created without password. Employee sets password at
                  first login.
                </p>
              </form>
            )}

            <div
              className={`mt-4 rounded-lg border p-3 ${theme === "dark" ? "border-white/10 bg-black/20" : "border-gray-200 bg-gray-50"}`}
            >
              <h3 className="text-sm font-semibold">Manage Employees</h3>
              <p className="mt-1 text-[11px] opacity-70">
                Search by name or email. Deleted employees are archived, keeping
                task history safe.
              </p>
              <EmployeeAutocomplete
                employees={employees}
                value={employeeSearch}
                onChange={setEmployeeSearch}
                onSelect={(employee) => setEmployeeSearch(employee.email)}
                placeholder="Search employee"
                theme={theme}
                className="mt-3"
              />

              {employeeActionError && (
                <p className="mt-2 text-xs text-red-400">
                  {employeeActionError}
                </p>
              )}
              {employeeActionSuccess && (
                <p className="mt-2 text-xs text-emerald-400">
                  {employeeActionSuccess}
                </p>
              )}

              <div className="mt-3 max-h-[300px] space-y-2 overflow-y-auto pr-1">
                {employeeSearchResults.map((employee) => {
                  const isEditing = editingEmployeeEmail === employee.email;
                  const displayName =
                    [employee.firstName, employee.lastName]
                      .filter(Boolean)
                      .join(" ") || "Unnamed employee";
                  return (
                    <div
                      key={employee._id || employee.email}
                      className={`rounded-md border p-2 ${theme === "dark" ? "border-white/10 bg-white/5" : "border-gray-200 bg-white"}`}
                    >
                      {isEditing ? (
                        <form onSubmit={saveEmployeeEdit} className="space-y-2">
                          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                            <input
                              name="firstName"
                              value={editEmployeeForm.firstName}
                              onChange={handleEditEmployeeInput}
                              placeholder="First name"
                              className={`rounded-md border px-2 py-1.5 text-xs ${theme === "dark" ? "border-white/10 bg-[#0f0f0f]" : "border-gray-200 bg-white"}`}
                            />
                            <input
                              name="lastName"
                              value={editEmployeeForm.lastName}
                              onChange={handleEditEmployeeInput}
                              placeholder="Last name"
                              className={`rounded-md border px-2 py-1.5 text-xs ${theme === "dark" ? "border-white/10 bg-[#0f0f0f]" : "border-gray-200 bg-white"}`}
                            />
                          </div>
                          <EmployeeAutocomplete
                            employees={employees}
                            inputName="email"
                            inputType="email"
                            value={editEmployeeForm.email}
                            onChange={(email) =>
                              setEditEmployeeForm((prev) => ({
                                ...prev,
                                email,
                              }))
                            }
                            placeholder="Email"
                            theme={theme}
                          />
                          <input
                            name="role"
                            value={editEmployeeForm.role}
                            onChange={handleEditEmployeeInput}
                            placeholder="Role, e.g. Developer"
                            className={`w-full rounded-md border px-2 py-1.5 text-xs ${theme === "dark" ? "border-white/10 bg-[#0f0f0f]" : "border-gray-200 bg-white"}`}
                          />
                          <p className="text-[10px] opacity-70">
                            Speciality is inferred automatically from role,
                            tasks, and completion patterns.
                          </p>
                          <div className="flex gap-2">
                            <button
                              type="submit"
                              className="rounded-md bg-emerald-500/20 px-2 py-1 text-[11px] font-semibold text-emerald-300"
                            >
                              Save
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditingEmployeeEmail("")}
                              className="rounded-md bg-white/10 px-2 py-1 text-[11px] font-semibold"
                            >
                              Cancel
                            </button>
                          </div>
                        </form>
                      ) : (
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <p className="truncate text-xs font-semibold">
                              {displayName}
                            </p>
                            <p className="truncate text-[11px] opacity-70">
                              {employee.email}
                            </p>
                            <p className="text-[10px] opacity-70">
                              {employee.isPasswordSet
                                ? "Active"
                                : "Not Activated"}{" "}
                              - {employee.role || "employee"} -{" "}
                              {employee.inferredSpeciality ||
                                "Speciality inferred"}
                            </p>
                          </div>
                          <div className="flex shrink-0 gap-1">
                            <button
                              type="button"
                              onClick={() => beginEditEmployee(employee)}
                              className="rounded-md border border-cyan-400/30 px-2 py-1 text-[11px] font-semibold text-cyan-300"
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => deleteEmployee(employee)}
                              className="rounded-md border border-red-400/30 px-2 py-1 text-[11px] font-semibold text-red-300"
                            >
                              Delete
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
                {employeeSearchResults.length === 0 && (
                  <p className="text-xs opacity-70">No employees found.</p>
                )}
              </div>
            </div>
          </div>
        </section>

        <section
          className={`rounded-xl border p-4 ${theme === "dark" ? "border-white/10 bg-[#181818] text-white" : "border-gray-200 bg-white text-gray-900"}`}
        >
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">Employee Cards</h3>
            <p className="text-[11px] opacity-70">
              Strengths, trend, and data-backed performance signals.
            </p>
          </div>
          <div className="mt-3 grid max-h-[460px] grid-cols-1 gap-3 overflow-y-auto pr-1 xl:grid-cols-2">
            {employeeCards.map((employee) => (
              <article
                key={employee._id || employee.email}
                className={`rounded-lg border p-3 ${theme === "dark" ? "border-white/10 bg-white/5" : "border-gray-200 bg-gray-50"}`}
              >
                {(() => {
                  const aiSignal = aiEmployeeSignalsByEmail.get(
                    String(employee.email || "").toLowerCase(),
                  );
                  const patternText =
                    aiSignal?.pattern || employee.cardSignalFallback.pattern;
                  const riskText =
                    aiSignal?.riskSignal ||
                    employee.cardSignalFallback.riskSignal;
                  const specializationText =
                    aiSignal?.specialization ||
                    employee.cardSignalFallback.specialization;
                  const changeText =
                    aiSignal?.changeSignal ||
                    employee.cardSignalFallback.changeSignal;
                  const patternIsAi = Boolean(aiSignal?.pattern);
                  const riskIsAi = Boolean(aiSignal?.riskSignal);
                  const specializationIsAi = Boolean(aiSignal?.specialization);
                  const changeIsAi = Boolean(aiSignal?.changeSignal);

                  return (
                    <>
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <h4 className="text-sm font-semibold">
                            {employee.firstName}
                          </h4>
                          <p className="text-[11px] opacity-70">
                            {employee.email}
                          </p>
                        </div>
                        <div className="flex flex-col items-end gap-1">
                          <span
                            className={`rounded-full px-2 py-1 text-[10px] font-semibold ${employee.isPasswordSet ? "bg-emerald-500/20 text-emerald-300" : "bg-yellow-500/20 text-yellow-300"}`}
                          >
                            {employee.isPasswordSet
                              ? "Activated"
                              : "First login pending"}
                          </span>
                          <span
                            className={`rounded-full px-2 py-1 text-[10px] font-semibold ${employee.trendMeta.className}`}
                          >
                            {employee.trendMeta.icon} {employee.trendMeta.label}
                          </span>
                          <span
                            title={employee.workloadStatus.detail}
                            className={`rounded-full border px-2 py-1 text-[10px] font-semibold ${employee.workloadStatus.className}`}
                          >
                            {employee.workloadStatus.label}
                          </span>
                        </div>
                      </div>

                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {employee.strengthTags.map((tag) => (
                          <span
                            key={`${employee.email}-${tag}`}
                            className={`rounded-full px-2 py-1 text-[10px] font-semibold ${theme === "dark" ? "bg-cyan-500/15 text-cyan-300" : "bg-cyan-100 text-cyan-800"}`}
                          >
                            {tag}
                          </span>
                        ))}
                        <span
                          className={`inline-flex items-center gap-0.5 rounded-full px-2 py-1 text-[10px] font-semibold ${theme === "dark" ? "bg-emerald-500/15 text-emerald-300" : "bg-emerald-100 text-emerald-800"}`}
                        >
                          {specializationText}
                          <DataSourceBadge
                            source={specializationIsAi ? "AI" : "SYS"}
                            className="!text-[9px] opacity-80"
                          />
                        </span>
                      </div>

                      <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                        <StatPill
                          theme={theme}
                          label="New"
                          value={employee.taskCounts?.newTask || 0}
                        />
                        <StatPill
                          theme={theme}
                          label="Active"
                          value={employee.taskCounts?.active || 0}
                        />
                        <StatPill
                          theme={theme}
                          label="Completed"
                          value={employee.taskCounts?.completed || 0}
                        />
                        <StatPill
                          theme={theme}
                          label="Failed"
                          value={employee.taskCounts?.failed || 0}
                        />
                      </div>

                      <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                        <StatPill
                          theme={theme}
                          label="Score"
                          value={
                            employee.ranking?.productivityScore?.toFixed?.(1) ||
                            "0.0"
                          }
                        />
                        <StatPill
                          theme={theme}
                          label="On-time"
                          value={`${employee.ranking?.stats?.onTimePercent?.toFixed?.(1) || "0.0"}%`}
                        />
                        <StatPill
                          theme={theme}
                          label="Avg"
                          value={`${employee.ranking?.stats?.averageCompletionTimeMinutes || 0} min`}
                        />
                      </div>

                      <div
                        className={`mt-3 rounded-md border p-2.5 text-[11px] ${employee.workloadStatus.className}`}
                      >
                        <p className="inline-flex flex-wrap items-center gap-1 font-semibold">
                          Workload: {employee.workloadStatus.label}
                          <DataSourceBadge
                            source="SYS"
                            className="!text-[9px] opacity-80"
                          />
                        </p>
                        <p className="mt-1 opacity-85">
                          {employee.workloadStatus.detail}
                        </p>
                      </div>

                      <div className="mt-3 rounded-md border border-white/10 bg-black/10 p-2.5 text-[11px]">
                        <p className="font-semibold opacity-80">
                          Why this score
                        </p>
                        <ul className="mt-1 list-disc space-y-1 pl-4 opacity-85">
                          <li>
                            Completion outcomes: {employee.completedCount}{" "}
                            completed vs {employee.failedCount} failed.
                          </li>
                          <li>
                            Pace:{" "}
                            {employee.ranking?.stats
                              ?.averageCompletionTimeMinutes || 0}{" "}
                            min average completion.
                          </li>
                          <li>
                            Reliability:{" "}
                            {employee.ranking?.stats?.onTimePercent?.toFixed?.(
                              1,
                            ) || "0.0"}
                            % on-time delivery.
                          </li>
                        </ul>
                        <p className="mt-2 text-[11px] opacity-85">
                          Pattern: {patternText}
                          <DataSourceBadge
                            source={patternIsAi ? "AI" : "SYS"}
                            className="inline"
                          />
                        </p>
                        <p className="mt-1 text-[11px] opacity-85">
                          Risk signal: {riskText}
                          <DataSourceBadge
                            source={riskIsAi ? "AI" : "SYS"}
                            className="inline"
                          />
                        </p>
                        <p className="mt-1 text-[11px] opacity-85">
                          Change signal: {changeText}
                          <DataSourceBadge
                            source={changeIsAi ? "AI" : "SYS"}
                            className="inline"
                          />
                        </p>
                      </div>

                      <div className="mt-3">
                        <p className="text-[11px] font-semibold opacity-70">
                          Recent activity
                        </p>
                        {employee.latestTasks.length === 0 ? (
                          <p className="text-xs opacity-70">
                            No recent activity yet.
                          </p>
                        ) : (
                          <ul className="mt-1 list-disc space-y-1 pl-4 text-xs">
                            {employee.latestTasks.map((line, idx) => (
                              <li key={idx}>{line}</li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </>
                  );
                })()}
              </article>
            ))}
          </div>
        </section>

        <section
          className={`rounded-xl border p-4 ${theme === "dark" ? "border-white/10 bg-[#181818] text-white" : "border-gray-200 bg-white text-gray-900"}`}
        >
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">Insights</h3>
            <p className="text-[11px] opacity-70">
              Data-backed analysis and AI recommendations
            </p>
          </div>
          {aiLoading && (
            <div className="mt-2 space-y-2">
              <div
                className={`h-3 w-3/4 animate-pulse rounded ${theme === "dark" ? "bg-white/10" : "bg-gray-200"}`}
              />
              <div
                className={`h-3 w-2/3 animate-pulse rounded ${theme === "dark" ? "bg-white/10" : "bg-gray-200"}`}
              />
            </div>
          )}
          <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
            <div
              className={`rounded-lg p-3 ${theme === "dark" ? "bg-white/5" : "bg-gray-50"}`}
            >
              <p className="text-xs opacity-70">Top performer (with reason)</p>
              <p className="font-semibold">{topPerformer?.name || "N/A"}</p>
              {topPerformer && (
                <>
                  <p className="mt-1 text-[11px] opacity-80">
                    Score {topPerformer.productivityScore.toFixed(1)} • On-time{" "}
                    {topPerformer.stats.onTimePercent.toFixed(1)}% • Avg{" "}
                    {topPerformer.stats.averageCompletionTimeMinutes} min
                  </p>
                  {leaderboardData.aiInsights?.topPerformer && (
                    <p
                      className="mt-1 text-[11px] leading-snug opacity-85"
                      title={leaderboardData.aiInsights.topPerformer}
                    >
                      {leaderboardData.aiInsights.topPerformer}
                      <DataSourceBadge
                        source={adminInsightSource}
                        className="inline"
                      />
                    </p>
                  )}
                  {leaderboardData.aiInsights?.mostImproved && (
                    <p
                      className="mt-1 text-[11px] leading-snug opacity-85"
                      title={leaderboardData.aiInsights.mostImproved}
                    >
                      Momentum: {leaderboardData.aiInsights.mostImproved}
                      <DataSourceBadge
                        source={adminInsightSource}
                        className="inline"
                      />
                    </p>
                  )}
                </>
              )}
            </div>
            <div
              className={`rounded-lg p-3 ${theme === "dark" ? "bg-white/5" : "bg-gray-50"}`}
            >
              <p className="text-xs opacity-70">
                Needs attention (with reason)
              </p>
              <p className="font-semibold">{lowPerformer?.name || "N/A"}</p>
              {lowPerformer && (
                <>
                  <p className="mt-1 text-[11px] opacity-80">
                    Score {lowPerformer.productivityScore.toFixed(1)} • On-time{" "}
                    {lowPerformer.stats.onTimePercent.toFixed(1)}% • Avg{" "}
                    {lowPerformer.stats.averageCompletionTimeMinutes} min
                  </p>
                  {leaderboardData.aiInsights?.needsAttention && (
                    <p
                      className="mt-1 text-[11px] leading-snug opacity-85"
                      title={leaderboardData.aiInsights.needsAttention}
                    >
                      {leaderboardData.aiInsights.needsAttention}
                      <DataSourceBadge
                        source={adminInsightSource}
                        className="inline"
                      />
                    </p>
                  )}
                </>
              )}
            </div>
          </div>

          <div
            className={`mt-3 max-h-[260px] overflow-y-auto rounded-lg p-3 ${theme === "dark" ? "bg-white/5" : "bg-gray-50"}`}
          >
            <p className="text-xs opacity-70">Quick actions</p>
            <div className="mt-2">
              <ActionableInsightList
                items={adminQuickPills}
                fallbackItems={fallbackRecommendations}
                limit={5}
                theme={theme}
                source={adminInsightSource}
              />
            </div>
          </div>

          {adminTeamPills.length > 0 && (
            <div
              className={`mt-3 max-h-[260px] overflow-y-auto rounded-lg p-3 ${theme === "dark" ? "bg-white/5" : "bg-gray-50"}`}
            >
              <p className="text-xs opacity-70">Team pattern analysis</p>
              <div className="mt-2">
                <ActionableInsightList
                  items={adminTeamPills}
                  limit={8}
                  theme={theme}
                  source={adminInsightSource}
                />
              </div>
            </div>
          )}
        </section>

        {loading && <LoadingSkeleton theme={theme} />}

        {error && (
          <div
            className={`rounded-lg border px-3 py-2 text-sm ${theme === "dark" ? "border-red-400/30 bg-red-500/10 text-red-300" : "border-red-200 bg-red-50 text-red-700"}`}
          >
            {error}
          </div>
        )}
      </section>
      <TaskChatDock
        tasks={chatTasks}
        user={{ name: "Admin", email: "admin", role: "admin" }}
        theme={theme}
        isAdmin
      />
    </div>
  );
};

const SummaryCard = ({ label, value, theme }) => (
  <div
    className={`rounded-xl border p-4 ${theme === "dark" ? "border-white/10 bg-[#1a1a1a] text-white" : "border-gray-200 bg-white text-gray-900"}`}
  >
    <p className="text-xs opacity-70">{label}</p>
    <p className="mt-1 text-2xl font-semibold">{value}</p>
  </div>
);

const StatPill = ({ theme, label, value }) => (
  <div
    className={`rounded-md p-2 ${theme === "dark" ? "bg-black/20" : "bg-white"}`}
  >
    {label}: {value}
  </div>
);

const LoadingSkeleton = ({ theme }) => (
  <section
    className={`rounded-xl border p-4 ${theme === "dark" ? "border-white/10 bg-[#181818]" : "border-gray-200 bg-white"}`}
  >
    <div className="space-y-3">
      <div
        className={`h-5 w-48 animate-pulse rounded ${theme === "dark" ? "bg-white/10" : "bg-gray-200"}`}
      />
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {[1, 2, 3].map((item) => (
          <div
            key={item}
            className={`h-24 animate-pulse rounded-lg ${theme === "dark" ? "bg-white/10" : "bg-gray-100"}`}
          />
        ))}
      </div>
    </div>
  </section>
);

const TaskMonitoringPanel = ({
  theme,
  data,
  loading = false,
  onDeleteSingle,
  onDeleteGroup,
  onExtendSingle,
  onExtendGroup,
  onExtendMember,
}) => {
  const isDark = theme === "dark";
  const groupTasks = data?.groupTasks || [];
  const singleTasks = data?.singleTasks || [];

  return (
    <section
      className={`rounded-2xl border p-4 md:p-5 ${isDark ? "border-white/10 bg-[#181818] text-white" : "border-gray-200 bg-white text-gray-900"}`}
    >
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">Real-time Task Monitor</h3>
          <p className="text-[11px] opacity-70">
            Tracking active, pending, and overdue tasks in real-time.
          </p>
        </div>
        <span className="rounded-full border px-2 py-1 text-[10px] font-semibold opacity-80">
          {groupTasks.length + singleTasks.length} tracked tasks
        </span>
      </div>

      {loading && (
        <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
          {["group", "single"].map((key) => (
            <div key={key} className="space-y-3">
              <div
                className={`h-4 w-32 animate-pulse rounded ${isDark ? "bg-white/10" : "bg-gray-200"}`}
              />
              {[1, 2].map((idx) => (
                <div
                  key={`${key}-${idx}`}
                  className={`h-28 rounded-lg border ${isDark ? "border-white/10 bg-white/5" : "border-gray-200 bg-gray-50"}`}
                />
              ))}
            </div>
          ))}
        </div>
      )}

      {!loading && (
        <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
          <div className="space-y-3">
            <h4 className="text-xs font-semibold uppercase tracking-wide opacity-70">
              Group Tasks
            </h4>
            {groupTasks.length === 0 ? (
              <div
                className={`rounded-lg border p-3 text-xs ${isDark ? "border-white/10 bg-black/20 text-white/70" : "border-gray-200 bg-gray-50 text-gray-600"}`}
              >
                No group tasks right now.
              </div>
            ) : (
              groupTasks.map((task) => (
                <article
                  key={task.groupId}
                  className={`rounded-lg border p-3 ${isDark ? "border-cyan-400/20 bg-cyan-500/5" : "border-cyan-200 bg-cyan-50"}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold">
                        {task.taskTitle || "Group task"}
                      </p>
                      <p className="text-[11px] opacity-70">
                        {task.category || "General"} • {task.members.length}{" "}
                        members
                      </p>
                      {task.statusLabel && (
                        <p className="mt-1 text-[10px] uppercase tracking-wide opacity-60">
                          {task.statusLabel}
                        </p>
                      )}
                    </div>
                    <div className="text-right text-[11px]">
                      <p className="font-semibold">
                        {task.displayOverallPercent ?? task.overallPercent}%
                      </p>
                      <p className="opacity-70">
                        {task.completedSteps}/{task.totalSteps || 0} subtasks
                      </p>
                      <p className="opacity-70">
                        {formatRemainingTime(task.overallRemainingMs)}
                      </p>
                      <button
                        type="button"
                        onClick={() => onDeleteGroup?.(task)}
                        className={`mt-1 rounded-md border px-2 py-1 text-[10px] font-semibold ${isDark ? "border-red-400/40 text-red-300 hover:bg-red-500/10" : "border-red-300 text-red-600 hover:bg-red-50"}`}
                      >
                        Delete
                      </button>
                      <button
                        type="button"
                        onClick={() => onExtendGroup?.(task)}
                        className={`mt-1 rounded-md border px-2 py-1 text-[10px] font-semibold ${isDark ? "border-cyan-400/40 text-cyan-200 hover:bg-cyan-500/10" : "border-cyan-200 text-cyan-700 hover:bg-cyan-50"}`}
                      >
                        Extend
                      </button>
                    </div>
                  </div>

                  <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-black/20">
                    <div
                      className="h-full rounded-full bg-cyan-400"
                      style={{
                        width: `${Math.max(
                          4,
                          task.displayOverallPercent ?? task.overallPercent,
                        )}%`,
                      }}
                    />
                  </div>

                  <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                    {task.members.map((member) => (
                      <div
                        key={`${task.groupId}-${member.email}`}
                        className={`rounded-md border p-2 ${isDark ? "border-white/10 bg-black/20" : "border-gray-200 bg-white"}`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="truncate text-xs font-semibold">
                              {member.name}
                            </p>
                            <p className="text-[11px] opacity-70">
                              {member.completedCount}/
                              {member.assignments.length} subtasks
                            </p>
                          </div>
                          <div className="text-right text-[11px]">
                            <p className="font-semibold">
                              {member.displayPercent ?? member.percent}%
                            </p>
                            <p className="opacity-70">
                              {formatRemainingTime(member.remainingMs)}
                            </p>
                            <button
                              type="button"
                              onClick={() => onExtendMember?.(task, member)}
                              className={`mt-1 rounded-md border px-2 py-1 text-[10px] font-semibold ${isDark ? "border-emerald-400/40 text-emerald-200 hover:bg-emerald-500/10" : "border-emerald-200 text-emerald-700 hover:bg-emerald-50"}`}
                            >
                              Extend
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </article>
              ))
            )}
          </div>

          <div className="space-y-3">
            <h4 className="text-xs font-semibold uppercase tracking-wide opacity-70">
              Single Tasks
            </h4>
            {singleTasks.length === 0 ? (
              <div
                className={`rounded-lg border p-3 text-xs ${isDark ? "border-white/10 bg-black/20 text-white/70" : "border-gray-200 bg-gray-50 text-gray-600"}`}
              >
                No single tasks right now.
              </div>
            ) : (
              singleTasks.map((task) => (
                <article
                  key={task.id}
                  className={`rounded-lg border p-3 ${isDark ? "border-emerald-400/20 bg-emerald-500/5" : "border-emerald-200 bg-emerald-50"}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold">{task.taskTitle}</p>
                      <p className="text-[11px] opacity-70">
                        {task.employeeName}
                      </p>
                      {task.statusLabel && (
                        <p className="mt-1 text-[10px] uppercase tracking-wide opacity-60">
                          {task.statusLabel}
                        </p>
                      )}
                    </div>
                    <div className="text-right text-[11px]">
                      <p className="font-semibold">
                        {task.displayProgressPercent ?? task.progressPercent}%
                      </p>
                      <p className="opacity-70">
                        {formatRemainingTime(task.remainingMs)}
                      </p>
                      <button
                        type="button"
                        onClick={() => onDeleteSingle?.(task)}
                        className={`mt-1 rounded-md border px-2 py-1 text-[10px] font-semibold ${isDark ? "border-red-400/40 text-red-300 hover:bg-red-500/10" : "border-red-300 text-red-600 hover:bg-red-50"}`}
                      >
                        Delete
                      </button>
                      <button
                        type="button"
                        onClick={() => onExtendSingle?.(task)}
                        className={`mt-1 rounded-md border px-2 py-1 text-[10px] font-semibold ${isDark ? "border-emerald-400/40 text-emerald-200 hover:bg-emerald-500/10" : "border-emerald-200 text-emerald-700 hover:bg-emerald-50"}`}
                      >
                        Extend
                      </button>
                    </div>
                  </div>

                  <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-black/20">
                    <div
                      className="h-full rounded-full bg-emerald-400"
                      style={{
                        width: `${Math.max(
                          4,
                          task.displayProgressPercent ?? task.progressPercent,
                        )}%`,
                      }}
                    />
                  </div>

                  <div className="mt-2 text-[11px] opacity-70">
                    {`${task.completedSteps || 0} / ${task.totalSteps || 0} subtasks completed`}
                  </div>
                </article>
              ))
            )}
          </div>
        </div>
      )}
    </section>
  );
};

export default AdminDashboard;
