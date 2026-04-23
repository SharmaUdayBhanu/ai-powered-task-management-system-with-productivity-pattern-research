import { useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import TaskDeadlineTimer from "./TaskDeadlineTimer";

const API_URL = `${import.meta.env.VITE_API_URL || ""}/api`;

const makeTaskIdentity = (task) =>
  String(
    task?._id ||
      `${task?.email || "unknown"}:${task?.taskTitle || "untitled"}:${task?.taskDate || "no-date"}`,
  );

const buildCacheKey = (task) =>
  `task-ai-insight-cache:${makeTaskIdentity(task)}`;

const normalizeSteps = (steps) =>
  Array.isArray(steps)
    ? steps.map((step) => String(step || "").trim()).filter(Boolean)
    : [];

const buildChecklistItems = (steps = [], checkedMap = {}) =>
  normalizeSteps(steps).map((text, idx) => {
    const id = `${idx}-${text.toLowerCase().replace(/\s+/g, "-").slice(0, 40)}`;
    return {
      id,
      text,
      completed: Boolean(checkedMap[id]),
    };
  });

const toSummaryPoints = (summary) =>
  String(summary || "")
    .split(/(?<=[.!?])\s+/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .slice(0, 4);

const readCachedInsight = (cacheKey) => {
  try {
    const parsed = JSON.parse(localStorage.getItem(cacheKey) || "null");
    if (!parsed || typeof parsed !== "object") return null;
    const steps = normalizeSteps(parsed.steps);
    if (!parsed.summary && steps.length === 0) return null;
    return {
      summary: String(parsed.summary || "").trim(),
      estimated_time: String(parsed.estimated_time || "").trim(),
      steps,
      checkedMap:
        parsed.checkedMap && typeof parsed.checkedMap === "object"
          ? parsed.checkedMap
          : {},
    };
  } catch {
    return null;
  }
};

const writeCachedInsight = (cacheKey, payload) => {
  try {
    localStorage.setItem(
      cacheKey,
      JSON.stringify({
        summary: payload.summary || "",
        estimated_time: payload.estimated_time || "",
        steps: normalizeSteps(payload.steps),
        checkedMap: payload.checkedMap || {},
      }),
    );
  } catch {
    // Ignore storage failures silently to avoid breaking UI.
  }
};

const AcceptTask = ({
  data,
  onStatusChange,
  onExplain,
  insightTeaser,
  theme = "dark",
}) => {
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("accepted"); // accepted, completed, failed
  const [success, setSuccess] = useState("");
  const [isInsightsVisible, setIsInsightsVisible] = useState(false);
  const [isInsightLoading, setIsInsightLoading] = useState(false);
  const [insightError, setInsightError] = useState("");
  const [insightPayload, setInsightPayload] = useState(null);
  const insightsScrollRef = useRef(null);

  const cacheKey = useMemo(() => buildCacheKey(data), [data]);

  useEffect(() => {
    const seededFromTask =
      data?.explainSummary ||
      (Array.isArray(data?.explainSteps) && data.explainSteps.length > 0)
        ? {
            summary: String(data.explainSummary || "").trim(),
            estimated_time: String(data.explainEstimatedTime || "").trim(),
            steps: normalizeSteps(data.explainSteps),
            checkedMap: readCachedInsight(cacheKey)?.checkedMap || {},
          }
        : null;

    const cached = readCachedInsight(cacheKey);
    const initial = seededFromTask || cached;
    setInsightPayload(initial);
    setInsightError("");
    setIsInsightsVisible(false);
  }, [cacheKey, data]);

  const updateTaskStatus = async (statusType) => {
    setLoading(true);
    try {
      const res = await axios.get(`${API_URL}/employees/${data.email}`);
      const employee = res.data;
      const taskIndex = employee.tasks.findIndex(
        (t) =>
          (data._id && String(t._id) === String(data._id)) ||
          (t.taskTitle === data.taskTitle &&
            t.taskDate === data.taskDate &&
            t.taskDescription === data.taskDescription),
      );
      if (taskIndex === -1) return;
      let updatedTask = { ...employee.tasks[taskIndex] };
      const now = new Date();
      if (statusType === "completed") {
        const startSource =
          updatedTask.startedAt ||
          updatedTask.acceptedAt ||
          updatedTask.createdAt ||
          updatedTask.assignedAt;
        const startTime = startSource ? new Date(startSource) : null;
        const derivedCompletionTime =
          startTime && !Number.isNaN(startTime.getTime())
            ? Math.max(0, Math.round((now - startTime) / 60000))
            : 0;

        updatedTask = {
          ...updatedTask,
          active: false,
          completed: true,
          failed: false,
          completedAt: now,
          completionTime: updatedTask.completionTime || derivedCompletionTime,
        };
      } else if (statusType === "failed") {
        updatedTask = {
          ...updatedTask,
          active: false,
          completed: false,
          failed: true,
          completedAt: now,
        };
      }
      const updatedTasks = [...employee.tasks];
      updatedTasks[taskIndex] = updatedTask;
      const oldCounts = employee.taskCounts || {
        newTask: 0,
        completed: 0,
        active: 0,
        failed: 0,
      };
      let updatedCounts = { ...oldCounts };
      updatedCounts.active = Math.max((oldCounts.active || 0) - 1, 0);
      if (statusType === "completed") {
        updatedCounts.completed = (oldCounts.completed || 0) + 1;
      } else if (statusType === "failed") {
        updatedCounts.failed = (oldCounts.failed || 0) + 1;
      }
      const updatedEmployee = {
        ...employee,
        tasks: updatedTasks,
        taskCounts: updatedCounts,
      };
      await axios.put(
        `${API_URL}/employees/${employee.email}`,
        updatedEmployee,
      );
      if (onStatusChange) onStatusChange();
      setStatus(statusType);
      setSuccess(
        statusType === "completed"
          ? "Task marked as completed!"
          : "Task marked as failed!",
      );
      setTimeout(() => setSuccess(""), 3000);
    } catch (err) {
      // handle error
    } finally {
      setLoading(false);
    }
  };

  let bgColor = "bg-red-500";
  if (status === "completed") bgColor = "bg-green-300";
  if (status === "failed") bgColor = "bg-orange-400";

  const checklistItems = useMemo(
    () =>
      buildChecklistItems(
        insightPayload?.steps,
        insightPayload?.checkedMap &&
          typeof insightPayload.checkedMap === "object"
          ? insightPayload.checkedMap
          : {},
      ),
    [insightPayload],
  );

  const completedCount = checklistItems.filter((item) => item.completed).length;
  const summaryPoints = useMemo(
    () => toSummaryPoints(insightPayload?.summary),
    [insightPayload?.summary],
  );

  const loadInsights = async () => {
    if (typeof onExplain === "function") {
      onExplain();
      return;
    }

    if (insightPayload) {
      setIsInsightsVisible((prev) => !prev);
      return;
    }

    setIsInsightLoading(true);
    setInsightError("");

    try {
      const requestBody = {
        employeeEmail: data.email,
        taskId: data._id,
        taskLookup: {
          taskTitle: data.taskTitle,
          taskDate: data.taskDate,
          taskDescription: data.taskDescription,
        },
        title: data.taskTitle,
        description: data.taskDescription,
        metadata: {
          category: data.category,
          complexity: data.complexity,
          estimatedDuration: data.estimatedDuration,
        },
      };

      const response = await axios.post(
        `${API_URL}/gemini/explain-task`,
        requestBody,
      );
      const fetched = response.data;

      if (fetched?.fromFallback) {
        setInsightError(
          "AI insights are currently unavailable. Continue with your task details and checklist planning manually.",
        );
        setIsInsightsVisible(true);
        return;
      }

      const normalized = {
        summary: String(fetched?.summary || "").trim(),
        estimated_time: String(
          fetched?.estimated_time || fetched?.estimatedTime || "",
        ).trim(),
        steps: normalizeSteps(fetched?.steps),
        checkedMap: {},
      };

      if (!normalized.summary && normalized.steps.length === 0) {
        throw new Error("No insights were returned.");
      }

      setInsightPayload(normalized);
      writeCachedInsight(cacheKey, normalized);
      setIsInsightsVisible(true);
    } catch {
      setInsightError(
        "AI insights are unavailable right now. You can still continue this task with the provided details.",
      );
      setIsInsightsVisible(true);
    } finally {
      setIsInsightLoading(false);
    }
  };

  const teaserText = String(insightTeaser || "").trim();
  const showInsightTeaser = Boolean(onExplain && teaserText);

  const toggleChecklistItem = (itemId) => {
    setInsightPayload((prev) => {
      if (!prev) return prev;
      const nextCheckedMap = {
        ...(prev.checkedMap || {}),
        [itemId]: !prev?.checkedMap?.[itemId],
      };
      const nextPayload = {
        ...prev,
        checkedMap: nextCheckedMap,
      };
      writeCachedInsight(cacheKey, nextPayload);
      return nextPayload;
    });
  };

  const containInsightsWheel = (event) => {
    const container = insightsScrollRef.current;
    event.stopPropagation();

    if (!container) return;
    const hasVerticalOverflow = container.scrollHeight > container.clientHeight;
    if (!hasVerticalOverflow) {
      event.preventDefault();
      return;
    }

    const atTop = container.scrollTop <= 0;
    const atBottom =
      container.scrollTop + container.clientHeight >=
      container.scrollHeight - 1;

    if ((event.deltaY < 0 && atTop) || (event.deltaY > 0 && atBottom)) {
      event.preventDefault();
    }
  };

  return (
    <div
      className={`flex-shrink-0 w-full max-w-[280px] h-fit min-w-0 ${bgColor} rounded-xl p-4 shadow-lg shadow-black/10 flex flex-col overflow-hidden transition-all duration-300 ease-in-out hover:shadow-2xl hover:shadow-black/20`}
    >
      <div className="flex justify-between items-center flex-shrink-0">
        <h3 className="bg-white text-red-600 px-3 py-1 rounded text-xs font-semibold">
          {data.category}
        </h3>
        <h4 className="text-sm">{data.taskDate}</h4>
      </div>
      <div className="flex justify-between items-center mt-2 flex-shrink-0">
        <span className="text-xs font-semibold bg-black/10 text-white px-2 py-1 rounded">
          AI Suggested Priority: {data.aiPriority || "Medium"}
        </span>
      </div>
      <div className="mt-2 flex justify-between items-center flex-shrink-0">
        <TaskDeadlineTimer task={data} theme={theme} />
      </div>
      <h2 className="mt-3 text-xl font-semibold flex-shrink-0 line-clamp-2">
        {data.taskTitle}
      </h2>
      <div className="min-w-0 overflow-hidden">
        <p className="text-sm mt-3 leading-relaxed line-clamp-4">
          {data.taskDescription}
        </p>
      </div>
      {success && (
        <div className="text-green-700 font-semibold mt-2 flex-shrink-0">
          {success}
        </div>
      )}
      {status === "accepted" && (
        <div className="flex justify-between mt-4 gap-2 flex-shrink-0">
          <button
            className="bg-white text-green-600 py-1 px-2 text-sm rounded-lg border border-green-600 flex-1 hover:bg-green-50 hover:scale-[1.02] active:scale-[0.98] transition-all duration-200 disabled:opacity-50"
            onClick={() => updateTaskStatus("completed")}
            disabled={loading}
          >
            {loading ? "Updating..." : "Mark as completed"}
          </button>
          <button
            className="bg-white text-red-600 py-1 px-2 text-sm rounded-lg border border-red-600 flex-1 hover:bg-red-50 hover:scale-[1.02] active:scale-[0.98] transition-all duration-200 disabled:opacity-50"
            onClick={() => updateTaskStatus("failed")}
            disabled={loading}
          >
            {loading ? "Updating..." : "Mark as failed"}
          </button>
        </div>
      )}
      {showInsightTeaser ? (
        <button
          onClick={loadInsights}
          className="mt-3 w-full rounded-lg border border-white/25 bg-white/15 px-2.5 py-2 text-left text-[11px] leading-relaxed text-white/95 transition-all duration-200 hover:bg-white/20"
          title="Open AI Insights"
        >
          <p className="text-[10px] font-semibold uppercase tracking-wide text-white/80">
            AI insights ready
          </p>
          <p className="mt-1 line-clamp-2">{teaserText}</p>
        </button>
      ) : (
        <button
          onClick={loadInsights}
          className="mt-3 h-8 w-full bg-white/90 text-red-700 text-xs font-semibold py-1.5 rounded-lg border border-red-600 hover:bg-white hover:scale-[1.02] active:scale-[0.98] transition-all duration-200 flex-shrink-0 disabled:opacity-60"
          disabled={isInsightLoading}
        >
          {isInsightLoading
            ? "Loading AI Insights..."
            : isInsightsVisible
              ? "Hide AI Insights"
              : "AI Insights"}
        </button>
      )}

      {isInsightsVisible && !onExplain && (
        <div
          onWheelCapture={(event) => event.stopPropagation()}
          onTouchMoveCapture={(event) => event.stopPropagation()}
          className={`mt-3 h-56 min-h-[14rem] rounded-lg border px-3 py-2 transition-all duration-300 ${
            theme === "dark"
              ? "border-white/20 bg-black/25 text-white"
              : "border-gray-200 bg-white/90 text-gray-900"
          }`}
        >
          <div
            ref={insightsScrollRef}
            data-insights-scroll-area="true"
            onWheel={containInsightsWheel}
            onTouchMove={(event) => event.stopPropagation()}
            className="h-full min-h-0 space-y-2 overflow-y-auto overflow-x-hidden overscroll-contain pr-1"
            style={{ scrollbarGutter: "stable" }}
          >
            {insightError ? (
              <p className="text-xs font-medium opacity-90">{insightError}</p>
            ) : (
              <>
                {summaryPoints.length > 0 && (
                  <section className="rounded-md border border-white/10 bg-black/10 p-2">
                    <p className="text-[11px] font-semibold uppercase tracking-wide opacity-80">
                      Overview
                    </p>
                    <ul className="mt-1.5 space-y-1">
                      {summaryPoints.map((point, idx) => (
                        <li
                          key={`${idx}-${point.slice(0, 16)}`}
                          className="text-xs leading-relaxed opacity-95"
                        >
                          • {point}
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
                {insightPayload?.estimated_time && (
                  <div className="rounded-md border border-white/10 bg-black/10 px-2 py-1.5 text-[11px] font-semibold opacity-90">
                    Estimated time: {insightPayload.estimated_time}
                  </div>
                )}

                {checklistItems.length > 0 && (
                  <section className="rounded-md border border-white/10 bg-black/10 p-2">
                    <div className="flex items-center justify-between text-[11px] font-semibold opacity-90">
                      <span>Execution checklist</span>
                      <span>
                        {completedCount}/{checklistItems.length} steps completed
                      </span>
                    </div>

                    <ul className="mt-2 space-y-2">
                      {checklistItems.map((item, idx) => (
                        <li key={item.id}>
                          <label className="flex cursor-pointer items-start gap-2 rounded-md border border-white/10 bg-white/[0.04] px-2 py-1.5 text-xs">
                            <span className="mt-[1px] rounded-full bg-white/10 px-1.5 py-0.5 text-[10px] font-semibold opacity-80">
                              {idx + 1}
                            </span>
                            <input
                              type="checkbox"
                              checked={item.completed}
                              onChange={() => toggleChecklistItem(item.id)}
                              className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded border-white/30"
                            />
                            <span
                              className={`min-w-0 break-words whitespace-normal transition-all duration-300 ${
                                item.completed
                                  ? "line-through opacity-60 translate-x-[1px]"
                                  : "opacity-95"
                              }`}
                            >
                              {item.text}
                            </span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default AcceptTask;
