import React, { useMemo, useState } from "react";

const getAiStatus = (task) => {
  if (task?.explainSummary || task?.aiPriorityReason) return "ready";
  if (task?.failed) return "retry";
  return "failed";
};

const statusMeta = {
  ready: {
    label: "AI Ready",
    className: "bg-emerald-500/20 text-emerald-400",
  },
  failed: {
    label: "AI Failed",
    className: "bg-red-500/20 text-red-300",
  },
  retry: {
    label: "Retry",
    className: "bg-yellow-500/20 text-yellow-300",
  },
};

const AdminInsightsPanel = ({
  employees = [],
  theme = "dark",
  onRegenerateInsight,
  refreshingAi,
}) => {
  const [expandedTaskId, setExpandedTaskId] = useState(null);

  const scopedEmployees = useMemo(() => {
    return employees
      .map((employee) => {
        const tasks = Array.isArray(employee.scopedTasks)
          ? employee.scopedTasks
          : Array.isArray(employee.tasks)
            ? employee.tasks
            : [];

        const latestTasks = [...tasks]
          .sort((a, b) => {
            const aDate = new Date(a.assignedAt || a.taskDate || 0).getTime();
            const bDate = new Date(b.assignedAt || b.taskDate || 0).getTime();
            return bDate - aDate;
          })
          .slice(0, 6);

        return {
          ...employee,
          latestTasks,
        };
      })
      .filter((employee) => employee.latestTasks.length > 0);
  }, [employees]);

  if (!scopedEmployees.length) return null;

  return (
    <section
      className={
        theme === "dark"
          ? "rounded-xl border border-white/10 bg-[#161616] p-4"
          : "rounded-xl border border-gray-200 bg-white p-4"
      }
    >
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">AI Insights & Task Logs</h2>
          <p className="text-xs opacity-70">
            Actionable summaries with quick retries, no technical noise.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 2xl:grid-cols-2">
        {scopedEmployees.map((employee) => (
          <div
            key={employee._id || employee.email}
            className={
              theme === "dark"
                ? "rounded-lg border border-white/10 bg-white/5 p-3"
                : "rounded-lg border border-gray-200 bg-gray-50 p-3"
            }
          >
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold">{employee.firstName}</h3>
                <p className="text-[11px] opacity-70">{employee.email}</p>
              </div>
              <div className="flex gap-2 text-[11px]">
                <Badge label="New" value={employee.taskCounts?.newTask || 0} />
                <Badge
                  label="Active"
                  value={employee.taskCounts?.active || 0}
                />
                <Badge
                  label="Done"
                  value={employee.taskCounts?.completed || 0}
                />
                <Badge
                  label="Failed"
                  value={employee.taskCounts?.failed || 0}
                />
              </div>
            </div>

            <div className="space-y-2">
              {employee.latestTasks.map((task) => {
                const taskId =
                  task._id || `${employee.email}-${task.taskTitle}`;
                const isExpanded = expandedTaskId === taskId;
                const aiStatus = getAiStatus(task);
                const status = statusMeta[aiStatus];
                const refreshKey = `${employee.email}:${task._id || task.taskTitle}`;
                const isRefreshing = refreshingAi === refreshKey;

                return (
                  <div
                    key={taskId}
                    className={
                      theme === "dark"
                        ? "rounded-md border border-white/10 bg-black/20"
                        : "rounded-md border border-gray-200 bg-white"
                    }
                  >
                    <button
                      type="button"
                      onClick={() =>
                        setExpandedTaskId((prev) =>
                          prev === taskId ? null : taskId,
                        )
                      }
                      className="flex w-full items-center justify-between px-3 py-2 text-left"
                    >
                      <div>
                        <p className="text-sm font-semibold">
                          {task.taskTitle}
                        </p>
                        <p className="text-[11px] opacity-70">
                          {task.category || "General"} •{" "}
                          {task.taskDate || "No deadline"}
                        </p>
                      </div>
                      <span
                        className={`rounded-full px-2 py-1 text-[10px] font-semibold ${status.className}`}
                      >
                        {status.label}
                      </span>
                    </button>

                    {isExpanded && (
                      <div className="border-t border-white/10 px-3 pb-3 pt-2 text-xs">
                        <div className="space-y-2">
                          <p className="font-semibold">Why this matters</p>
                          <p className="opacity-85">
                            {task.explainSummary ||
                              "This task affects delivery consistency and team productivity goals."}
                          </p>

                          <p className="font-semibold">What to do next</p>
                          {Array.isArray(task.explainSteps) &&
                          task.explainSteps.length > 0 ? (
                            <ul className="list-disc space-y-1 pl-4 opacity-90">
                              {task.explainSteps
                                .slice(0, 4)
                                .map((step, idx) => (
                                  <li key={idx}>{step}</li>
                                ))}
                            </ul>
                          ) : (
                            <ul className="list-disc space-y-1 pl-4 opacity-90">
                              <li>
                                Break this task into smaller execution steps.
                              </li>
                              <li>
                                Prioritize blockers first to reduce delay risk.
                              </li>
                              <li>
                                Update progress checkpoints during the day.
                              </li>
                            </ul>
                          )}

                          <div className="flex items-center justify-between pt-1">
                            <span className="text-[11px] opacity-70">
                              Priority: {task.aiPriority || "Medium"}
                            </span>
                            <button
                              type="button"
                              onClick={() =>
                                onRegenerateInsight?.(employee, task)
                              }
                              disabled={isRefreshing}
                              className="rounded-md border border-cyan-400/40 px-2 py-1 text-[11px] font-semibold text-cyan-300 disabled:opacity-60"
                            >
                              {isRefreshing
                                ? "Regenerating..."
                                : "Regenerate Insight"}
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
};

const Badge = ({ label, value }) => (
  <span className="rounded-md bg-black/10 px-2 py-1 font-semibold">
    {label}: {value}
  </span>
);

export default AdminInsightsPanel;
