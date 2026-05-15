import React, { useEffect, useState } from "react";
import {
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ScatterChart,
  Scatter,
  LineChart,
  Line,
} from "recharts";
import { getWithRetry, sanitizeApiError } from "../lib/apiClient";
import getSocket from "../lib/socket";
import { ENABLE_REALTIME } from "../lib/realtime";
import ActionableInsightList from "./ActionableInsightList";
import DataSourceBadge from "./DataSourceBadge";

const ProductivityDashboard = ({ employee, theme = "dark" }) => {
  const [stats, setStats] = useState(null);
  const [chartData, setChartData] = useState(null);
  const [insights, setInsights] = useState([]);
  const [analysis, setAnalysis] = useState(null);
  const [insightEngine, setInsightEngine] = useState("sys");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const fetchProductivityData = async (
    employeeId,
    { forceInsights = false, includeInsights = true, silent = false } = {},
  ) => {
    const insightsPath = forceInsights
      ? `/productivity/${employeeId}/insights?force=true`
      : `/productivity/${employeeId}/insights`;

    const coreRequests = [
      getWithRetry(`/productivity/${employeeId}/stats`, { maxRetries: 2 }),
      getWithRetry(`/productivity/${employeeId}/chart-data`, {
        maxRetries: 2,
      }),
    ];

    const results = await Promise.allSettled(
      includeInsights
        ? [...coreRequests, getWithRetry(insightsPath, { maxRetries: 2 })]
        : coreRequests,
    );

    const statsResult = results[0];
    const chartResult = results[1];
    const insightsResult = includeInsights ? results[2] : null;

    const nextStats =
      statsResult.status === "fulfilled" ? statsResult.value.data : null;
    const nextChart =
      chartResult.status === "fulfilled" ? chartResult.value.data : null;
    const nextInsights =
      insightsResult && insightsResult.status === "fulfilled"
        ? insightsResult.value.data?.insights || []
        : null;
    const nextAnalysis =
      insightsResult && insightsResult.status === "fulfilled"
        ? insightsResult.value.data?.analysis || null
        : null;
    const nextEngine =
      insightsResult && insightsResult.status === "fulfilled"
        ? insightsResult.value.data?.insightEngine || "sys"
        : null;

    if (nextStats) setStats(nextStats);
    if (nextChart) setChartData(nextChart);
    if (includeInsights && nextInsights !== null) {
      setInsights(nextInsights);
      setAnalysis(nextAnalysis);
      if (nextEngine) setInsightEngine(nextEngine);
    }

    const hasCoreData = Boolean(nextStats && nextChart);
    if (!silent) {
      setError(hasCoreData ? "" : "Failed to load productivity data.");
    }
    return hasCoreData;
  };

  useEffect(() => {
    if (!employee?._id) {
      setLoading(false);
      setError("Employee ID missing for productivity view.");
      return;
    }

    const fetchData = async () => {
      setLoading(true);
      setError("");
      try {
        await fetchProductivityData(employee._id, {
          includeInsights: true,
          silent: false,
        });
      } catch (err) {
        setError(sanitizeApiError(err, "Failed to load productivity data."));
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [employee?._id]);

  useEffect(() => {
    if (!employee?._id) return;

    const intervalId = window.setInterval(() => {
      fetchProductivityData(employee._id, {
        includeInsights: false,
        silent: true,
      }).catch(() => {});
    }, 45_000);

    return () => window.clearInterval(intervalId);
  }, [employee?._id]);

  useEffect(() => {
    if (!employee?._id) return;
    if (!ENABLE_REALTIME) {
      return undefined;
    }

    const socket = getSocket();

    const refreshData = async () => {
      try {
        await fetchProductivityData(employee._id, {
          includeInsights: false,
          silent: true,
        });
      } catch (err) {
        console.warn("Failed to refresh productivity data:", err);
      }
    };

    const onEmployeeUpdated = ({ email }) => {
      if (employee.email === email) refreshData();
    };

    const onTaskCreated = ({ email }) => {
      if (employee.email === email) refreshData();
    };

    const onTaskStatusChanged = ({ email }) => {
      if (employee.email !== email) return;
      fetchProductivityData(employee._id, {
        forceInsights: true,
        includeInsights: true,
        silent: true,
      }).catch(() => {
        refreshData();
      });
    };

    const onTaskActionCompleted = ({
      email,
      employeeId,
      action,
      taskTitle,
      taskDescription,
      taskStatus,
    }) => {
      if (employee.email !== email) return;

      const refreshInsights = async () => {
        try {
          const params = new URLSearchParams({
            force: "true",
            action,
            taskTitle: taskTitle || "",
            taskDescription: taskDescription || "",
            taskStatus,
          });
          const [insightsRes, statsResult, chartResult] =
            await Promise.allSettled([
              getWithRetry(
                `/productivity/${employeeId}/insights?${params.toString()}`,
                { maxRetries: 2 },
              ),
              getWithRetry(`/productivity/${employeeId}/stats`, {
                maxRetries: 2,
              }),
              getWithRetry(`/productivity/${employeeId}/chart-data`, {
                maxRetries: 2,
              }),
            ]);
          if (insightsRes.status === "fulfilled") {
            setInsights(insightsRes.value.data?.insights || []);
            setAnalysis(insightsRes.value.data?.analysis || null);
            if (insightsRes.value.data?.insightEngine) {
              setInsightEngine(insightsRes.value.data.insightEngine);
            }
          }
          if (statsResult.status === "fulfilled") {
            setStats(statsResult.value.data);
          }
          if (chartResult.status === "fulfilled") {
            setChartData(chartResult.value.data);
          }
        } catch (err) {
          console.warn("Failed to refresh insights:", err);
          refreshData();
        }
      };

      refreshInsights();
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
  }, [employee?._id, employee?.email]);

  if (!employee) return null;

  const narrativeSource = insightEngine === "ai" ? "AI" : "SYS";

  const performanceScore = Number(stats?.productivityScore ?? 0);

  const weeklyDelta = stats?.productivityTrendDelta || 0;
  const weeklySummary =
    weeklyDelta > 0
      ? `Your productivity improved by ${weeklyDelta} tasks this week.`
      : weeklyDelta < 0
        ? `You closed ${Math.abs(weeklyDelta)} fewer tasks this week. Let's recover momentum.`
        : "Your productivity is stable this week.";

  const cardClass =
    theme === "dark"
      ? "mt-6 bg-[#101010] rounded-xl p-4 border border-white/5"
      : "mt-6 bg-white rounded-xl p-4 shadow border border-gray-100";

  const SkeletonLoader = () => (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
        {[1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className={`p-3 rounded ${
              theme === "dark" ? "bg-white/5" : "bg-gray-50"
            }`}
          >
            <div
              className={`h-3 w-20 mb-2 rounded animate-pulse ${
                theme === "dark" ? "bg-white/10" : "bg-gray-200"
              }`}
            />
            <div
              className={`h-5 w-16 rounded animate-pulse ${
                theme === "dark" ? "bg-white/10" : "bg-gray-200"
              }`}
            />
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {[1, 2].map((i) => (
          <div key={i} className="h-52">
            <div
              className={`h-4 w-32 mb-2 rounded animate-pulse ${
                theme === "dark" ? "bg-white/10" : "bg-gray-200"
              }`}
            />
            <div
              className={`h-full rounded animate-pulse ${
                theme === "dark" ? "bg-white/5" : "bg-gray-100"
              }`}
            />
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div className={cardClass}>
      <h2
        className={`text-lg font-semibold mb-2 ${
          theme === "dark" ? "text-white" : "text-gray-900"
        }`}
      >
        Productivity Insights for {employee.firstName}
      </h2>

      {error && (
        <div
          className={`text-sm ${
            theme === "dark" ? "text-red-400" : "text-red-600"
          } mb-2`}
        >
          {error}
        </div>
      )}

      {loading ? (
        <SkeletonLoader />
      ) : stats && chartData ? (
        <div className="space-y-4">
          <div
            className={`rounded-lg border p-3 ${
              theme === "dark"
                ? "border-cyan-400/20 bg-cyan-500/10"
                : "border-cyan-100 bg-cyan-50"
            }`}
          >
            <p className="text-xs uppercase tracking-wide opacity-70">
              Performance Score
            </p>
            <div className="mt-1 flex items-center justify-between">
              <p className="text-2xl font-semibold">{performanceScore}</p>
              <span className="text-xs font-semibold opacity-80">
                {weeklyDelta >= 0 ? "📈 Improving" : "📉 Needs focus"}
              </span>
            </div>
            <p className="mt-1 text-sm opacity-90">{weeklySummary}</p>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <MetricCard
              label="Avg completion"
              value={`${stats.averageCompletionTimeMinutes} min`}
              theme={theme}
            />
            <MetricCard
              label="On-time"
              value={`${stats.onTimePercent.toFixed(1)}%`}
              theme={theme}
            />
            <MetricCard
              label="Delayed"
              value={`${stats.delayedPercent.toFixed(1)}%`}
              theme={theme}
            />
            <MetricCard
              label="Peak hours"
              value={stats.peakProductivityWindow}
              theme={theme}
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="h-52">
              <h3
                className={`text-sm font-semibold mb-1 ${
                  theme === "dark" ? "text-white" : "text-gray-900"
                }`}
              >
                Productivity trend (last {chartData.windowDays || 14} days)
              </h3>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData.tasksPerDay}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="dateLabel" />
                  <YAxis />
                  <Tooltip />
                  <Line
                    type="monotone"
                    dataKey="count"
                    stroke="#3b82f6"
                    strokeWidth={2}
                    dot={{ r: 3 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="h-52">
              <h3
                className={`text-sm font-semibold mb-1 ${
                  theme === "dark" ? "text-white" : "text-gray-900"
                }`}
              >
                Completion-time deviation (dot view)
              </h3>
              {(chartData.completionDurationDots || []).length === 0 ? (
                <div
                  className={`h-full flex items-center justify-center text-xs rounded border ${
                    theme === "dark"
                      ? "text-gray-400 border-white/10 bg-white/5"
                      : "text-gray-600 border-gray-200 bg-gray-50"
                  }`}
                >
                  No completed task duration data yet.
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <ScatterChart>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis
                      type="number"
                      dataKey="completedAtTs"
                      domain={["dataMin", "dataMax"]}
                      tickFormatter={(value) =>
                        new Date(value).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                        })
                      }
                    />
                    <YAxis
                      type="number"
                      dataKey="completionTimeMinutes"
                      unit="m"
                    />
                    <Tooltip
                      formatter={(value, name) => {
                        if (name === "completionTimeMinutes")
                          return [`${value} min`, "Completion Time"];
                        return [value, name];
                      }}
                      labelFormatter={(value) =>
                        `Completed on ${new Date(value).toLocaleDateString(
                          "en-US",
                          {
                            month: "short",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          },
                        )}`
                      }
                    />
                    <Scatter
                      data={chartData.completionDurationDots || []}
                      fill="#22c55e"
                    />
                  </ScatterChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          <div className="mt-2">
            <h3
              className={`text-sm font-semibold mb-1 ${
                theme === "dark" ? "text-white" : "text-gray-900"
              }`}
            >
              {narrativeSource === "AI" ? "AI Insights" : "Productivity Guidance"}
            </h3>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div
                className={`rounded-lg border p-3 ${
                  theme === "dark"
                    ? "border-white/10 bg-white/5"
                    : "border-gray-200 bg-gray-50"
                }`}
              >
                <p className="text-xs font-semibold uppercase tracking-wide opacity-70">
                  Quick actions
                </p>
                <div className="mt-2">
                  <ActionableInsightList
                    items={analysis?.quickActionPills || insights}
                    fallbackItems={[
                      "Complete one more task this week to strengthen your completion sample.",
                    ]}
                    limit={4}
                    theme={theme}
                    source={narrativeSource}
                  />
                </div>
              </div>
              <div
                className={`rounded-lg border p-3 ${
                  theme === "dark"
                    ? "border-white/10 bg-white/5"
                    : "border-gray-200 bg-gray-50"
                }`}
              >
                <p className="text-xs font-semibold uppercase tracking-wide opacity-70">
                  Risk signals
                </p>
                <div className="mt-2">
                  <ActionableInsightList
                    items={analysis?.riskPills || []}
                    fallbackItems={[
                      `Watch failed-task volume (${stats?.failedTaskCount ?? 0}) against completions before taking on new scope.`,
                    ]}
                    limit={4}
                    theme={theme}
                    source={narrativeSource}
                  />
                </div>
              </div>
            </div>

            <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
              <div
                className={`rounded-lg border p-3 ${
                  theme === "dark"
                    ? "border-white/10 bg-white/5"
                    : "border-gray-200 bg-gray-50"
                }`}
              >
                <p className="text-xs font-semibold uppercase tracking-wide opacity-70">
                  Pattern
                </p>
                <p className="mt-1 text-xs leading-relaxed opacity-90">
                  {analysis?.pattern ||
                    "Execution pattern will appear as more completed history is observed."}
                  <DataSourceBadge
                    source={narrativeSource}
                    className="inline"
                  />
                </p>
              </div>

              <div
                className={`rounded-lg border p-3 ${
                  theme === "dark"
                    ? "border-white/10 bg-white/5"
                    : "border-gray-200 bg-gray-50"
                }`}
              >
                <p className="text-xs font-semibold uppercase tracking-wide opacity-70">
                  Specialization
                </p>
                <p className="mt-1 text-xs leading-relaxed opacity-90">
                  {analysis?.specialization ||
                    "Specialization signal will appear once category-performance patterns become clearer."}
                  <DataSourceBadge
                    source={narrativeSource}
                    className="inline"
                  />
                </p>
              </div>

              <div
                className={`rounded-lg border p-3 ${
                  theme === "dark"
                    ? "border-white/10 bg-white/5"
                    : "border-gray-200 bg-gray-50"
                }`}
              >
                <p className="text-xs font-semibold uppercase tracking-wide opacity-70">
                  Change detection
                </p>
                <p className="mt-1 text-xs leading-relaxed opacity-90">
                  {(analysis?.changeDetection?.status || "stable")
                    .charAt(0)
                    .toUpperCase() +
                    (analysis?.changeDetection?.status || "stable").slice(1)}
                  :{" "}
                  {analysis?.changeDetection?.reason ||
                    "No major week-over-week shift detected."}
                  <DataSourceBadge
                    source={narrativeSource}
                    className="inline"
                  />
                </p>
              </div>

              <div
                className={`rounded-lg border p-3 ${
                  theme === "dark"
                    ? "border-white/10 bg-white/5"
                    : "border-gray-200 bg-gray-50"
                }`}
              >
                <p className="text-xs font-semibold uppercase tracking-wide opacity-70">
                  Workload outlook
                </p>
                <p className="mt-1 text-xs leading-relaxed opacity-90">
                  {analysis?.workloadOutlook ? (
                    <>
                      <span className="font-semibold text-[11px]">
                        {analysis.workloadOutlook.headline}
                      </span>
                      <span className="opacity-90">
                        {" "}
                        — {analysis.workloadOutlook.rationale}
                      </span>
                      <DataSourceBadge
                        source={
                          analysis.workloadOutlook.source === "ai"
                            ? "AI"
                            : "SYS"
                        }
                        className="inline"
                      />
                    </>
                  ) : (
                    <>
                      Outlook appears once active and new task counts stabilize
                      in the feed.
                      <DataSourceBadge
                        source={narrativeSource}
                        className="inline"
                      />
                    </>
                  )}
                </p>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};

const MetricCard = ({ label, value, theme }) => (
  <div
    className={`rounded-lg border p-3 ${
      theme === "dark"
        ? "border-white/10 bg-white/5 text-gray-100"
        : "border-gray-200 bg-gray-50 text-gray-900"
    }`}
  >
    <p className="text-[11px] uppercase tracking-wide opacity-70">{label}</p>
    <p className="mt-1 text-sm font-semibold">{value}</p>
  </div>
);

export default ProductivityDashboard;
