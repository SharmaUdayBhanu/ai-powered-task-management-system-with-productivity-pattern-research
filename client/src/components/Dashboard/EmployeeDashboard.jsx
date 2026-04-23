import React, { useMemo, useState, useEffect } from "react";
import Header from "../other/Header";
import TaskListNumbers from "../other/TaskListNumbers";
import TaskList from "../TaskList/TaskList";
import ProductivityDashboard from "../ProductivityDashboard";
import { io } from "socket.io-client";
import { Moon, Sun, TrendingDown, TrendingUp } from "lucide-react";
import { getWithRetry, sanitizeApiError } from "../../lib/apiClient";

const SOCKET_URL = import.meta.env.VITE_API_URL || window.location.origin;

const getPriorityWeight = (priority) => {
  if (priority === "High") return 3;
  if (priority === "Medium") return 2;
  return 1;
};

const getTaskDateTs = (task) => {
  const value =
    task.taskDate ||
    task.acceptanceDeadline ||
    task.assignedAt ||
    task.startedAt ||
    task.completedAt;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
};

const getWeekBounds = () => {
  const now = new Date();
  const currentWeekStart = new Date(now);
  currentWeekStart.setDate(now.getDate() - 6);
  currentWeekStart.setHours(0, 0, 0, 0);

  const previousWeekStart = new Date(currentWeekStart);
  previousWeekStart.setDate(currentWeekStart.getDate() - 7);

  return { currentWeekStart, previousWeekStart };
};

const EmployeeDashboard = ({ data }) => {
  const [employee, setEmployee] = useState(data);
  const [refreshKey, setRefreshKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [theme, setTheme] = useState("dark");
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [error, setError] = useState("");

  const fetchEmployee = async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    try {
      const res = await getWithRetry(`/employees/${data.email}`, {
        maxRetries: 2,
      });
      setEmployee(res.data);
      setError("");
    } catch (err) {
      setEmployee((prev) => prev || data);
      setError(sanitizeApiError(err, "Could not refresh employee data."));
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    if (isModalOpen) {
      return;
    }

    fetchEmployee();
  }, [data.email, refreshKey, isModalOpen]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      if (!isModalOpen) {
        fetchEmployee({ silent: true });
      }
    }, 45_000);

    return () => window.clearInterval(intervalId);
  }, [isModalOpen, data.email]);

  useEffect(() => {
    const socket = io(SOCKET_URL, { transports: ["websocket"] });

    socket.on("employeeUpdated", ({ email, employee }) => {
      if (email === data.email) {
        setEmployee(employee);
        if (!isModalOpen) {
          setRefreshKey((prev) => prev + 1);
        }
      }
    });

    socket.on(
      "taskExplanationGenerated",
      ({ employeeEmail, updatedEmployee }) => {
        if (employeeEmail === data.email && updatedEmployee) {
          setEmployee(updatedEmployee);
        }
      },
    );

    return () => socket.disconnect();
  }, [data.email, isModalOpen]);

  const handleAccept = () => setRefreshKey((prev) => prev + 1);

  const focusTasks = useMemo(() => {
    const tasks = (employee?.tasks || [])
      .filter(
        (task) =>
          !task.isDeleted && !task.notAccepted && (task.newTask || task.active),
      )
      .sort((a, b) => {
        const priorityDiff =
          getPriorityWeight(b.aiPriority) - getPriorityWeight(a.aiPriority);
        if (priorityDiff !== 0) return priorityDiff;
        return getTaskDateTs(a) - getTaskDateTs(b);
      });

    return tasks.slice(0, 4);
  }, [employee]);

  const nextAction = useMemo(() => {
    const urgent = focusTasks.find((task) => task.aiPriority === "High");
    if (urgent) {
      return `Start with “${urgent.taskTitle}” now. It is high priority and time-sensitive.`;
    }

    const activeTask = focusTasks.find((task) => task.active);
    if (activeTask) {
      return `Continue “${activeTask.taskTitle}” and close one milestone in the next 60 minutes.`;
    }

    if (focusTasks[0]) {
      return `Pick “${focusTasks[0].taskTitle}” as your first focus block today.`;
    }

    return "No urgent items right now. Review completed tasks and plan tomorrow's top 3 priorities.";
  }, [focusTasks]);

  const weeklySummary = useMemo(() => {
    const { currentWeekStart, previousWeekStart } = getWeekBounds();
    let current = 0;
    let previous = 0;

    (employee?.tasks || []).forEach((task) => {
      if (!task.completedAt || !task.completed) return;
      const completedAt = new Date(task.completedAt);
      if (Number.isNaN(completedAt.getTime())) return;

      if (completedAt >= currentWeekStart) current += 1;
      else if (
        completedAt >= previousWeekStart &&
        completedAt < currentWeekStart
      )
        previous += 1;
    });

    const delta = current - previous;
    const percent =
      previous > 0
        ? Math.round((delta / previous) * 100)
        : current > 0
          ? 100
          : 0;
    return { current, previous, delta, percent };
  }, [employee]);

  const summaryText =
    weeklySummary.delta >= 0
      ? `Your productivity improved by ${Math.abs(weeklySummary.percent)}% this week.`
      : `Your productivity is down by ${Math.abs(weeklySummary.percent)}% this week.`;

  if (loading) {
    return (
      <div
        className={
          theme === "dark"
            ? "min-h-screen bg-[#1C1C1C] p-6"
            : "min-h-screen bg-white p-6"
        }
      >
        <div className="mx-auto max-w-[1280px] space-y-4">
          <div
            className={`h-24 rounded-xl animate-pulse ${theme === "dark" ? "bg-white/10" : "bg-gray-200"}`}
          />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <div
              className={`h-44 rounded-xl animate-pulse ${theme === "dark" ? "bg-white/10" : "bg-gray-200"}`}
            />
            <div
              className={`h-44 rounded-xl animate-pulse ${theme === "dark" ? "bg-white/10" : "bg-gray-200"}`}
            />
            <div
              className={`h-44 rounded-xl animate-pulse ${theme === "dark" ? "bg-white/10" : "bg-gray-200"}`}
            />
          </div>
        </div>
      </div>
    );
  }

  if (!employee) {
    return <div>Employee not found</div>;
  }

  return (
    <div
      className={
        theme === "dark"
          ? "p-2 md:p-10 bg-[#1C1C1C] min-h-screen overflow-x-auto"
          : "p-2 md:p-10 bg-white min-h-screen overflow-x-auto"
      }
    >
      <div className="flex justify-end mb-2">
        <button
          type="button"
          aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
          className={
            theme === "dark"
              ? "group relative inline-flex h-11 w-28 items-center rounded-full border border-white/15 bg-[#111111] px-2 text-white transition-all duration-300 hover:border-cyan-300/60"
              : "group relative inline-flex h-11 w-28 items-center rounded-full border border-gray-300 bg-gray-100 px-2 text-gray-900 transition-all duration-300 hover:border-amber-400"
          }
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        >
          <span
            className={`absolute top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full shadow-md transition-all duration-300 ${
              theme === "dark"
                ? "left-2 bg-slate-800 text-cyan-200"
                : "left-[calc(100%-2.5rem)] bg-amber-300 text-amber-800"
            }`}
          >
            {theme === "dark" ? <Moon size={16} /> : <Sun size={16} />}
          </span>
          <span className="sr-only">
            {theme === "dark" ? "Dark mode active" : "Light mode active"}
          </span>
          <span
            className={`text-xs font-semibold tracking-wide uppercase transition-all duration-300 ${
              theme === "dark" ? "ml-11" : "ml-2"
            }`}
          >
            {theme === "dark" ? "Dark" : "Light"}
          </span>
        </button>
      </div>
      <Header data={employee} theme={theme} showSectionNav={false} />
      <div className="mx-auto mt-6 w-full max-w-[1280px] space-y-4">
        {error && (
          <div
            className={`rounded-lg border px-3 py-2 text-sm ${theme === "dark" ? "border-red-400/30 bg-red-500/10 text-red-300" : "border-red-200 bg-red-50 text-red-700"}`}
          >
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
          <section
            className={`rounded-xl border p-4 xl:col-span-2 ${theme === "dark" ? "border-white/10 bg-[#101010] text-white" : "border-gray-200 bg-white text-gray-900"}`}
          >
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Today's Focus Tasks</h2>
              <span className="text-xs opacity-70">
                Prioritized by urgency + AI priority
              </span>
            </div>
            <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
              {focusTasks.length === 0 ? (
                <div
                  className={`rounded-lg border p-3 text-sm ${theme === "dark" ? "border-white/10 bg-white/5 text-gray-300" : "border-gray-200 bg-gray-50 text-gray-600"}`}
                >
                  No pending focus tasks right now.
                </div>
              ) : (
                focusTasks.map((task) => (
                  <article
                    key={task._id || task.taskTitle}
                    className={`rounded-lg border p-3 ${theme === "dark" ? "border-white/10 bg-white/5" : "border-gray-200 bg-gray-50"}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="text-sm font-semibold">
                        {task.taskTitle}
                      </h3>
                      <span
                        className={`rounded-full px-2 py-1 text-[10px] font-semibold ${
                          task.aiPriority === "High"
                            ? "bg-red-500/20 text-red-400"
                            : task.aiPriority === "Low"
                              ? "bg-emerald-500/20 text-emerald-400"
                              : "bg-yellow-500/20 text-yellow-300"
                        }`}
                      >
                        {task.aiPriority || "Medium"}
                      </span>
                    </div>
                    <p className="mt-1 text-xs opacity-70">
                      {task.category || "General"} •{" "}
                      {task.taskDate || "No deadline"}
                    </p>
                  </article>
                ))
              )}
            </div>
          </section>

          <section
            className={`rounded-xl border p-4 ${theme === "dark" ? "border-white/10 bg-[#101010] text-white" : "border-gray-200 bg-white text-gray-900"}`}
          >
            <h2 className="text-lg font-semibold">Suggested Next Action</h2>
            <p className="mt-3 text-sm leading-relaxed opacity-90">
              {nextAction}
            </p>

            <div
              className={`mt-4 rounded-lg p-3 ${theme === "dark" ? "bg-white/5" : "bg-gray-50"}`}
            >
              <p className="text-xs uppercase tracking-wide opacity-70">
                Weekly comparison
              </p>
              <p className="mt-1 flex items-center gap-2 text-sm font-semibold">
                {weeklySummary.delta >= 0 ? (
                  <TrendingUp size={16} className="text-emerald-400" />
                ) : (
                  <TrendingDown size={16} className="text-rose-400" />
                )}
                <span>{summaryText}</span>
              </p>
              <p className="mt-1 text-xs opacity-70">
                This week: {weeklySummary.current} completed • Last week:{" "}
                {weeklySummary.previous}
              </p>
            </div>
          </section>
        </div>

        <div id="overview" className="scroll-mt-28">
          <TaskListNumbers data={employee} theme={theme} />
        </div>
        <div id="insights" className="scroll-mt-28">
          <ProductivityDashboard employee={employee} theme={theme} />
        </div>
        <div
          className={`w-full rounded-xl border p-3 md:p-4 ${theme === "dark" ? "border-white/10 bg-[#101010]" : "border-gray-200 bg-white"}`}
        >
          <div className="mb-3 flex items-center justify-between">
            <h2
              className={`text-lg font-semibold ${theme === "dark" ? "text-white" : "text-gray-900"}`}
            >
              Task Board
            </h2>
            <p
              className={`text-xs ${theme === "dark" ? "text-gray-400" : "text-gray-600"}`}
            >
              Filter tasks and expand AI guidance as needed.
            </p>
          </div>
          <TaskList
            data={employee}
            onAccept={handleAccept}
            vertical
            theme={theme}
            onModalStateChange={setIsModalOpen}
          />
        </div>
      </div>
    </div>
  );
};

export default EmployeeDashboard;
