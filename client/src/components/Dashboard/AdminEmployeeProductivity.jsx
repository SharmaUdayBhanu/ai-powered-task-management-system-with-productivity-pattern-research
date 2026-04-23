import React, { useEffect, useState } from "react";
import axios from "axios";
import { io } from "socket.io-client";
import {
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
  ScatterChart,
  Scatter,
} from "recharts";
import {
  ENABLE_REALTIME,
  REALTIME_SOCKET_OPTIONS,
  REALTIME_SOCKET_URL,
} from "../../lib/realtime";

const API_URL = `${import.meta.env.VITE_API_URL || ""}/api`;

const AdminEmployeeProductivity = ({ employee, theme = "dark" }) => {
  const [stats, setStats] = useState(null);
  const [chartData, setChartData] = useState(null);
  const [insights, setInsights] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchProductivityData = async (
    employeeId,
    { forceInsights = false } = {},
  ) => {
    const insightsPath = forceInsights
      ? `${API_URL}/productivity/${employeeId}/insights?force=true`
      : `${API_URL}/productivity/${employeeId}/insights`;
    const [statsResult, chartResult, insightsResult] = await Promise.allSettled(
      [
        axios.get(`${API_URL}/productivity/${employeeId}/stats`),
        axios.get(`${API_URL}/productivity/${employeeId}/chart-data`),
        axios.get(insightsPath),
      ],
    );

    const nextStats =
      statsResult.status === "fulfilled" ? statsResult.value.data : null;
    const nextChart =
      chartResult.status === "fulfilled" ? chartResult.value.data : null;
    const nextInsights =
      insightsResult.status === "fulfilled"
        ? insightsResult.value.data?.insights || []
        : [];

    if (nextStats) setStats(nextStats);
    if (nextChart) setChartData(nextChart);
    setInsights(nextInsights);

    return Boolean(nextStats && nextChart);
  };

  useEffect(() => {
    if (!employee?._id) {
      setLoading(false);
      return;
    }

    const fetchData = async () => {
      setLoading(true);
      try {
        await fetchProductivityData(employee._id);
      } catch (err) {
        console.warn("Failed to load productivity data:", err);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [employee?._id, employee?.tasks?.length]);

  // Real-time updates
  useEffect(() => {
    if (!employee?._id) return;
    if (!ENABLE_REALTIME) {
      return undefined;
    }

    const socket = io(REALTIME_SOCKET_URL, REALTIME_SOCKET_OPTIONS);

    const refreshData = async () => {
      try {
        await fetchProductivityData(employee._id);
      } catch (err) {
        console.warn("Failed to refresh:", err);
      }
    };

    socket.on("employeeUpdated", ({ email }) => {
      if (employee.email === email) refreshData();
    });

    socket.on("taskCreated", ({ email }) => {
      if (employee.email === email) refreshData();
    });

    socket.on("taskStatusChanged", ({ email }) => {
      if (employee.email === email) {
        fetchProductivityData(employee._id, { forceInsights: true }).catch(
          () => {
            refreshData();
          },
        );
      }
    });

    socket.on("taskActionCompleted", ({ email }) => {
      if (employee.email === email) {
        fetchProductivityData(employee._id, { forceInsights: true }).catch(
          () => {
            refreshData();
          },
        );
      }
    });

    return () => socket.disconnect();
  }, [employee?._id, employee?.email]);

  if (loading || !stats || !chartData) {
    return (
      <div
        className={`p-4 rounded-lg ${theme === "dark" ? "bg-gray-800" : "bg-gray-50"}`}
      >
        <div
          className={`text-sm ${theme === "dark" ? "text-gray-400" : "text-gray-600"}`}
        >
          Loading...
        </div>
      </div>
    );
  }

  return (
    <div
      className={`p-4 rounded-lg border ${theme === "dark" ? "bg-gray-800 border-gray-700" : "bg-white border-gray-200"}`}
    >
      <h3
        className={`text-base font-semibold mb-3 ${theme === "dark" ? "text-white" : "text-gray-900"}`}
      >
        {employee.firstName} - Productivity Metrics
      </h3>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm mb-4">
        <div
          className={`p-2 rounded ${theme === "dark" ? "bg-gray-700" : "bg-gray-100"}`}
        >
          <div
            className={`text-xs ${theme === "dark" ? "text-gray-400" : "text-gray-600"}`}
          >
            Avg time
          </div>
          <div
            className={`font-semibold ${theme === "dark" ? "text-white" : "text-gray-900"}`}
          >
            {stats.averageCompletionTimeMinutes} min
          </div>
        </div>
        <div
          className={`p-2 rounded ${theme === "dark" ? "bg-gray-700" : "bg-gray-100"}`}
        >
          <div
            className={`text-xs ${theme === "dark" ? "text-gray-400" : "text-gray-600"}`}
          >
            On-time
          </div>
          <div
            className={`font-semibold ${theme === "dark" ? "text-white" : "text-gray-900"}`}
          >
            {stats.onTimePercent.toFixed(1)}%
          </div>
        </div>
        <div
          className={`p-2 rounded ${theme === "dark" ? "bg-gray-700" : "bg-gray-100"}`}
        >
          <div
            className={`text-xs ${theme === "dark" ? "text-gray-400" : "text-gray-600"}`}
          >
            Delayed
          </div>
          <div
            className={`font-semibold ${theme === "dark" ? "text-white" : "text-gray-900"}`}
          >
            {stats.delayedPercent.toFixed(1)}%
          </div>
        </div>
        <div
          className={`p-2 rounded ${theme === "dark" ? "bg-gray-700" : "bg-gray-100"}`}
        >
          <div
            className={`text-xs ${theme === "dark" ? "text-gray-400" : "text-gray-600"}`}
          >
            Peak hours
          </div>
          <div
            className={`font-semibold ${theme === "dark" ? "text-white" : "text-gray-900"}`}
          >
            {stats.peakProductivityWindow}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
        <div className="h-48">
          <h4
            className={`text-xs font-semibold mb-1 ${theme === "dark" ? "text-white" : "text-gray-900"}`}
          >
            Tasks per day (last {chartData.windowDays || 14} days)
          </h4>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData.tasksPerDay}>
              <CartesianGrid
                strokeDasharray="3 3"
                stroke={theme === "dark" ? "#444" : "#ddd"}
              />
              <XAxis
                dataKey="dateLabel"
                stroke={theme === "dark" ? "#999" : "#666"}
              />
              <YAxis stroke={theme === "dark" ? "#999" : "#666"} />
              <Tooltip />
              <Bar dataKey="count" fill="#3b82f6" />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="h-48">
          <h4
            className={`text-xs font-semibold mb-1 ${theme === "dark" ? "text-white" : "text-gray-900"}`}
          >
            Completion-time deviation (dot view)
          </h4>
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
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke={theme === "dark" ? "#444" : "#ddd"}
                />
                <XAxis
                  type="number"
                  dataKey="completedAtTs"
                  domain={["dataMin", "dataMax"]}
                  stroke={theme === "dark" ? "#999" : "#666"}
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
                  stroke={theme === "dark" ? "#999" : "#666"}
                />
                <Tooltip
                  formatter={(value, name) => {
                    if (name === "completionTimeMinutes")
                      return [`${value} min`, "Completion Time"];
                    return [value, name];
                  }}
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

      {insights.length > 0 && (
        <div
          className={`text-xs ${theme === "dark" ? "text-gray-300" : "text-gray-700"}`}
        >
          <h4
            className={`font-semibold mb-1 ${theme === "dark" ? "text-white" : "text-gray-900"}`}
          >
            AI Insights:
          </h4>
          <ul className="list-disc list-inside space-y-1">
            {insights.map((msg, idx) => (
              <li key={idx}>{msg}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

export default AdminEmployeeProductivity;
