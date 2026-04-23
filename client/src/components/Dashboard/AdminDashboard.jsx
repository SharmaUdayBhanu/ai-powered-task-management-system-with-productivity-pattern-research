import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { io } from "socket.io-client";
import Header from "../other/Header";
import CreateTask from "../other/CreateTask";
import {
  getWithRetry,
  postWithRetry,
  sanitizeApiError,
} from "../../lib/apiClient";
import {
  ENABLE_REALTIME,
  REALTIME_SOCKET_OPTIONS,
  REALTIME_SOCKET_URL,
} from "../../lib/realtime";


const toPercent = (value, base) => {
  const safeBase = Number(base) || 0;
  if (safeBase <= 0) return 0;
  return Number(((Number(value) / safeBase) * 100).toFixed(1));
};

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

  const fetchDashboardData = useCallback(async ({ includeAI = false } = {}) => {
    const [employeeRes, rankingRes] = await Promise.allSettled([
      getWithRetry("/employees", { fallbackValue: { data: [] } }),
      getWithRetry(`/productivity/rankings?includeAI=${includeAI}`, {
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

    const socket = io(REALTIME_SOCKET_URL, REALTIME_SOCKET_OPTIONS);
    const triggerRefresh = () => {
      fetchDashboardData({ includeAI: false });
      scheduleAiRefresh();
    };

    socket.on("employeeUpdated", triggerRefresh);
    socket.on("taskCreated", triggerRefresh);
    socket.on("taskStatusChanged", triggerRefresh);
    socket.on("taskActionCompleted", triggerRefresh);

    return () => socket.disconnect();
  }, [fetchDashboardData, scheduleAiRefresh]);

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
            <span>
              {lastSync
                ? `Last sync: ${lastSync.toLocaleTimeString()}`
                : "Syncing..."}
            </span>
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
              <CreateTask theme={theme} onTaskCreated={fetchDashboardData} />
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
                          className={`rounded-full px-2 py-1 text-[10px] font-semibold ${theme === "dark" ? "bg-emerald-500/15 text-emerald-300" : "bg-emerald-100 text-emerald-800"}`}
                        >
                          {specializationText}
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
                        </p>
                        <p className="mt-1 text-[11px] opacity-85">
                          Risk signal: {riskText}
                        </p>
                        <p className="mt-1 text-[11px] opacity-85">
                          Change signal: {changeText}
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
                <p className="mt-1 text-[11px] opacity-80">
                  Score {topPerformer.productivityScore.toFixed(1)} • On-time{" "}
                  {topPerformer.stats.onTimePercent.toFixed(1)}% • Avg{" "}
                  {topPerformer.stats.averageCompletionTimeMinutes} min
                </p>
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
                <p className="mt-1 text-[11px] opacity-80">
                  Score {lowPerformer.productivityScore.toFixed(1)} • On-time{" "}
                  {lowPerformer.stats.onTimePercent.toFixed(1)}% • Avg{" "}
                  {lowPerformer.stats.averageCompletionTimeMinutes} min
                </p>
              )}
            </div>
          </div>

          <div
            className={`mt-3 max-h-[260px] overflow-y-auto rounded-lg p-3 ${theme === "dark" ? "bg-white/5" : "bg-gray-50"}`}
          >
            <p className="text-xs opacity-70">
              Recommendations (pattern + metric)
            </p>
            <ul className="mt-1 list-disc space-y-1 pl-4 text-xs">
              {(
                leaderboardData.aiInsights?.recommendations || [
                  ...fallbackRecommendations,
                ]
              ).map((tip, idx) => (
                <li key={idx}>{tip}</li>
              ))}
            </ul>
          </div>

          {(leaderboardData.aiInsights?.teamPattern ||
            leaderboardData.aiInsights?.workloadImbalance ||
            leaderboardData.aiInsights?.failureClusters ||
            (leaderboardData.aiInsights?.underutilizedEmployees || []).length >
              0 ||
            (leaderboardData.aiInsights?.changeSignals || []).length > 0) && (
            <div
              className={`mt-3 max-h-[260px] overflow-y-auto rounded-lg p-3 ${theme === "dark" ? "bg-white/5" : "bg-gray-50"}`}
            >
              <p className="text-xs opacity-70">Team pattern analysis</p>
              <ul className="mt-1 list-disc space-y-1 pl-4 text-xs">
                {leaderboardData.aiInsights?.teamPattern && (
                  <li>{leaderboardData.aiInsights.teamPattern}</li>
                )}
                {leaderboardData.aiInsights?.workloadImbalance && (
                  <li>{leaderboardData.aiInsights.workloadImbalance}</li>
                )}
                {leaderboardData.aiInsights?.failureClusters && (
                  <li>{leaderboardData.aiInsights.failureClusters}</li>
                )}
                {(leaderboardData.aiInsights?.underutilizedEmployees || []).map(
                  (msg, idx) => (
                    <li key={`underutilized-${idx}`}>{msg}</li>
                  ),
                )}
                {(leaderboardData.aiInsights?.changeSignals || []).map(
                  (msg, idx) => (
                    <li key={`change-${idx}`}>{msg}</li>
                  ),
                )}
              </ul>
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

export default AdminDashboard;
