import { useState, useRef, useEffect, useMemo } from "react";
import axios from "axios";
import { Filter, ChevronDown } from "lucide-react";
import AcceptTask from "./AcceptTask";
import NewTask from "./NewTask";
import CompleteTask from "./CompleteTask";
import FailedTask from "./FailedTask";
import ExplainTaskModal from "../ExplainTaskModal";

const API_URL = import.meta.env.VITE_API_URL + "/api";

const FILTER_OPTIONS = [
  { value: "all", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "notAccepted", label: "Not Accepted" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
  { value: "active", label: "Active" },
  { value: "new", label: "New" },
];

const getTaskId = (task) => task._id || `${task.taskTitle}-${task.taskDate}`;

const matchesFilter = (task, filter) => {
  if (filter === "all") return true;
  if (filter === "pending") return task.newTask || task.active;
  if (filter === "notAccepted") return task.notAccepted;
  if (filter === "completed") return task.completed;
  if (filter === "failed") return task.failed;
  if (filter === "new") return task.newTask;
  if (filter === "active") return task.active;
  return true;
};

const PRIORITY_ORDER = {
  High: 3,
  Medium: 2,
  Low: 1,
};

const getTaskTimestamp = (task) => {
  const candidates = [
    task.assignedAt,
    task.acceptedAt,
    task.startedAt,
    task.completedAt,
    task.taskDate,
  ];

  for (const value of candidates) {
    if (!value) continue;
    const ts = new Date(value).getTime();
    if (!Number.isNaN(ts)) return ts;
  }

  return 0;
};

const hasValidExplanation = (payload) =>
  Boolean(
    payload &&
    ((typeof payload.summary === "string" && payload.summary.trim()) ||
      (Array.isArray(payload.steps) && payload.steps.length > 0)),
  );

const TaskList = ({ data, onAccept, vertical, theme, onModalStateChange }) => {
  const explainedStorageKey = `explained-ai-tasks:${data.email}`;
  const [modalOpen, setModalOpen] = useState(false);
  const [modalLoading, setModalLoading] = useState(false);
  const [modalError, setModalError] = useState("");
  const [explanation, setExplanation] = useState(null);
  const [currentTaskId, setCurrentTaskId] = useState(null);
  const [highlightedTaskId, setHighlightedTaskId] = useState(null);
  const [explainedTaskIds, setExplainedTaskIds] = useState(() => {
    try {
      return new Set(
        JSON.parse(localStorage.getItem(explainedStorageKey)) || [],
      );
    } catch {
      return new Set();
    }
  });
  const [activeFilter, setActiveFilter] = useState("all");
  const [filterOpen, setFilterOpen] = useState(false);
  const [isDraggingScrollbar, setIsDraggingScrollbar] = useState(false);
  const [scrollState, setScrollState] = useState({
    left: 0,
    width: 100,
    canScroll: false,
  });
  const scrollRef = useRef(null);
  const trackRef = useRef(null);
  const thumbRef = useRef(null);
  const dragStateRef = useRef(null);
  const rafUpdateRef = useRef(null);
  const modalStateRef = useRef({
    isOpen: false,
    explanation: null,
    loading: false,
    taskId: null,
  });

  const visibleTasks = useMemo(() => {
    const filtered = (data.tasks || []).filter(
      (task) => !task.isDeleted && matchesFilter(task, activeFilter),
    );

    return [...filtered].sort((a, b) => {
      const timeDiff = getTaskTimestamp(b) - getTaskTimestamp(a);
      if (timeDiff !== 0) return timeDiff;

      return (
        (PRIORITY_ORDER[b.aiPriority] || 0) -
        (PRIORITY_ORDER[a.aiPriority] || 0)
      );
    });
  }, [data.tasks, activeFilter]);

  const updateScrollState = () => {
    const el = scrollRef.current;
    if (!el) return;

    const { scrollLeft, scrollWidth, clientWidth } = el;
    const canScroll = scrollWidth > clientWidth + 1;
    const width = canScroll
      ? Math.max((clientWidth / scrollWidth) * 100, 12)
      : 100;
    const maxLeft = Math.max(100 - width, 0);
    const left = canScroll
      ? Math.min((scrollLeft / (scrollWidth - clientWidth)) * maxLeft, maxLeft)
      : 0;

    setScrollState((prev) => {
      if (
        Math.abs(prev.left - left) < 0.1 &&
        Math.abs(prev.width - width) < 0.1 &&
        prev.canScroll === canScroll
      ) {
        return prev;
      }
      return { left, width, canScroll };
    });
  };

  const scheduleUpdateScrollState = () => {
    if (rafUpdateRef.current) return;
    rafUpdateRef.current = requestAnimationFrame(() => {
      rafUpdateRef.current = null;
      updateScrollState();
    });
  };

  useEffect(() => {
    updateScrollState();
    window.addEventListener("resize", scheduleUpdateScrollState);
    return () => {
      window.removeEventListener("resize", scheduleUpdateScrollState);
      if (rafUpdateRef.current) {
        cancelAnimationFrame(rafUpdateRef.current);
        rafUpdateRef.current = null;
      }
    };
  }, [visibleTasks.length]);

  useEffect(() => {
    try {
      setExplainedTaskIds(
        new Set(JSON.parse(localStorage.getItem(explainedStorageKey)) || []),
      );
    } catch {
      setExplainedTaskIds(new Set());
    }
  }, [explainedStorageKey]);

  useEffect(() => {
    localStorage.setItem(
      explainedStorageKey,
      JSON.stringify(Array.from(explainedTaskIds)),
    );
  }, [explainedStorageKey, explainedTaskIds]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ left: 0, behavior: "smooth" });
    scheduleUpdateScrollState();
  }, [activeFilter]);

  useEffect(() => {
    const handlePointerMove = (event) => {
      const drag = dragStateRef.current;
      const el = scrollRef.current;
      const thumb = thumbRef.current;
      if (!drag || !el) return;

      const delta = event.clientX - drag.startX;
      const nextThumbLeft = Math.min(
        Math.max(drag.startThumbLeft + delta, 0),
        drag.maxThumbTravel,
      );

      if (thumb) {
        const nextLeftPercent = (nextThumbLeft / drag.trackWidth) * 100;
        thumb.style.left = `${nextLeftPercent}%`;
      }

      el.scrollLeft = (nextThumbLeft / drag.maxThumbTravel) * drag.maxScroll;
    };

    const handlePointerUp = () => {
      dragStateRef.current = null;
      setIsDraggingScrollbar(false);
      document.body.style.userSelect = "";
      if (thumbRef.current) {
        thumbRef.current.style.left = "";
        thumbRef.current.style.transitionDuration = "";
      }
      updateScrollState();
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, []);

  // Expose modal state to parent to prevent reloads
  useEffect(() => {
    if (onModalStateChange) {
      onModalStateChange(modalOpen || modalStateRef.current.isOpen);
    }
  }, [modalOpen, onModalStateChange]);

  // Persist modal state across re-renders (e.g., when Socket.io updates data)
  useEffect(() => {
    if (modalOpen) {
      modalStateRef.current.isOpen = true;
      modalStateRef.current.explanation = explanation;
      modalStateRef.current.loading = modalLoading;
      modalStateRef.current.taskId = currentTaskId;
    }
  }, [modalOpen, explanation, modalLoading, currentTaskId]);

  // Restore modal state if it was open but got reset due to data update
  // Use a more aggressive approach - always restore if ref says modal should be open
  useEffect(() => {
    // If ref says modal is open but state says it's closed, restore it
    if (modalStateRef.current.isOpen && !modalOpen) {
      // Restore modal state immediately
      setModalOpen(true);
      if (modalStateRef.current.explanation) {
        setExplanation(modalStateRef.current.explanation);
      }
      setModalLoading(modalStateRef.current.loading);
      if (modalStateRef.current.taskId) {
        setCurrentTaskId(modalStateRef.current.taskId);
      }
    }
  }, [data, modalOpen]);

  const handleExplain = async (task) => {
    if (!task) return;
    const taskId = getTaskId(task);
    setCurrentTaskId(taskId);
    setModalOpen(true);
    setModalError("");
    setExplanation(null);

    if (task.explainSummary || (task.explainSteps || []).length > 0) {
      const cachedExplanation = {
        summary: task.explainSummary || "Task guidance is available.",
        steps: Array.isArray(task.explainSteps) ? task.explainSteps : [],
        estimated_time: task.explainEstimatedTime || "N/A",
        fromCache: true,
      };
      modalStateRef.current.explanation = cachedExplanation;
      setExplanation(cachedExplanation);
      setExplainedTaskIds((prev) => new Set(prev).add(taskId));
      setModalLoading(false);
      return;
    }

    setModalLoading(true);

    try {
      const body = {
        employeeEmail: data.email,
        taskId: task._id,
        taskLookup: {
          taskTitle: task.taskTitle,
          taskDate: task.taskDate,
          taskDescription: task.taskDescription,
        },
        title: task.taskTitle,
        description: task.taskDescription,
        metadata: {
          category: task.category,
          complexity: task.complexity,
          estimatedDuration: task.estimatedDuration,
        },
      };
      const res = await axios.post(`${API_URL}/gemini/explain-task`, body);
      if (!hasValidExplanation(res.data)) {
        throw new Error("AI returned an empty explanation. Please try again.");
      }
      // Store explanation in ref immediately to prevent loss on re-render
      modalStateRef.current.explanation = res.data;
      setExplanation(res.data);
      setExplainedTaskIds((prev) => new Set(prev).add(taskId));
      // Don't close modal - let user close it manually
    } catch (err) {
      setModalError("Unable to load AI guidance right now. Please try again.");
      // Keep modal open even on error so user can see the error message
    } finally {
      setModalLoading(false);
    }
  };

  const handleTrackClick = (event) => {
    const el = scrollRef.current;
    const track = trackRef.current;
    if (!el || !track || event.target !== track) return;

    const rect = track.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / rect.width;
    const targetLeft = ratio * (el.scrollWidth - el.clientWidth);
    el.scrollTo({ left: targetLeft, behavior: "smooth" });
    scheduleUpdateScrollState();
  };

  const handleThumbPointerDown = (event) => {
    const track = trackRef.current;
    const el = scrollRef.current;
    if (!track) return;
    if (!el) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setIsDraggingScrollbar(true);
    document.body.style.userSelect = "none";
    const trackWidth = track.clientWidth;
    const thumbWidth = (scrollState.width / 100) * trackWidth;
    const maxThumbTravel = Math.max(trackWidth - thumbWidth, 1);
    const maxScroll = Math.max(el.scrollWidth - el.clientWidth, 1);

    if (thumbRef.current) {
      thumbRef.current.style.transitionDuration = "0ms";
    }

    dragStateRef.current = {
      startX: event.clientX,
      startThumbLeft: (scrollState.left / 100) * track.clientWidth,
      thumbWidth,
      trackWidth,
      maxThumbTravel,
      maxScroll,
    };
  };

  const handleListScroll = () => {
    if (dragStateRef.current) return;
    scheduleUpdateScrollState();
  };

  const handleListWheel = (event) => {
    const el = scrollRef.current;
    if (!el || !scrollState.canScroll) return;

    const targetElement = event.target;
    if (
      targetElement instanceof HTMLElement &&
      targetElement.closest("[data-insights-scroll-area='true']")
    ) {
      return;
    }

    if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
    event.preventDefault();
    el.scrollLeft += event.deltaX;
  };

  const handleCloseModal = () => {
    const taskIdToHighlight = currentTaskId;
    setModalOpen(false);
    modalStateRef.current.isOpen = false;
    modalStateRef.current.explanation = null;
    modalStateRef.current.loading = false;
    setExplanation(null);
    setModalError("");

    // Highlight the tile that was explained
    if (taskIdToHighlight) {
      setHighlightedTaskId(taskIdToHighlight);

      // Scroll to the highlighted tile smoothly
      setTimeout(() => {
        const taskElement = document.querySelector(
          `[data-task-id="${taskIdToHighlight}"]`,
        );
        if (taskElement) {
          taskElement.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }, 100);

      // Remove highlight after animation
      setTimeout(() => {
        setHighlightedTaskId(null);
      }, 2000);
    }

    // Update employee data to show new AI guidance in tile
    // We'll update the data prop directly without triggering a full reload
    // The explanation is already saved in the database, so we just need to refresh the view
    // Don't call onAccept() here as it triggers a full page reload
    // Instead, the Socket.io event will update the data when modal is closed
  };

  return (
    <>
      <div className="mb-4 flex w-full flex-col gap-3 lg:flex-row lg:items-center">
        <div className="relative">
          <button
            type="button"
            onClick={() => setFilterOpen((open) => !open)}
            className={`flex h-10 w-full items-center justify-center gap-2 rounded-lg border px-4 text-sm font-semibold transition-all duration-200 lg:w-auto ${
              theme === "dark"
                ? "border-white/10 bg-white/10 text-white hover:bg-white/15"
                : "border-gray-200 bg-white text-gray-800 shadow-sm hover:bg-gray-50"
            }`}
          >
            <Filter size={16} />
            {
              FILTER_OPTIONS.find((option) => option.value === activeFilter)
                ?.label
            }
            <ChevronDown
              size={16}
              className={`transition-transform duration-200 ${
                filterOpen ? "rotate-180" : ""
              }`}
            />
          </button>

          {filterOpen && (
            <div
              className={`absolute left-0 top-12 z-30 w-48 overflow-hidden rounded-lg border shadow-xl ${
                theme === "dark"
                  ? "border-white/10 bg-[#181818] text-white"
                  : "border-gray-200 bg-white text-gray-900"
              }`}
            >
              {FILTER_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => {
                    setActiveFilter(option.value);
                    setFilterOpen(false);
                  }}
                  className={`flex w-full items-center justify-between px-4 py-2 text-left text-sm transition-colors ${
                    activeFilter === option.value
                      ? theme === "dark"
                        ? "bg-white/15"
                        : "bg-gray-100"
                      : theme === "dark"
                        ? "hover:bg-white/10"
                        : "hover:bg-gray-50"
                  }`}
                >
                  {option.label}
                  <span className="text-xs opacity-70">
                    {
                      (data.tasks || []).filter(
                        (task) =>
                          !task.isDeleted && matchesFilter(task, option.value),
                      ).length
                    }
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div
          className={`flex min-h-10 flex-1 items-center gap-3 rounded-lg border px-3 ${
            theme === "dark"
              ? "border-white/10 bg-white/[0.04]"
              : "border-gray-200 bg-gray-50"
          }`}
        >
          <span
            className={`hidden text-xs font-medium sm:block ${
              theme === "dark" ? "text-gray-300" : "text-gray-600"
            }`}
          >
            {visibleTasks.length} of{" "}
            {(data.tasks || []).filter((task) => !task.isDeleted).length} tasks
          </span>
          <div
            ref={trackRef}
            onClick={handleTrackClick}
            className={`relative h-2 flex-1 cursor-pointer rounded-full ${
              theme === "dark" ? "bg-white/10" : "bg-gray-200"
            }`}
          >
            <div
              ref={thumbRef}
              onPointerDown={handleThumbPointerDown}
              className={`absolute top-1/2 h-2.5 -translate-y-1/2 rounded-full transition-colors duration-150 touch-none ${
                theme === "dark"
                  ? "bg-cyan-300 hover:bg-cyan-200"
                  : "bg-gray-800 hover:bg-gray-700"
              } ${isDraggingScrollbar ? "cursor-grabbing" : "cursor-grab"}`}
              style={{
                left: `${scrollState.left}%`,
                width: `${scrollState.width}%`,
                willChange: "left, width",
              }}
            />
          </div>
        </div>
      </div>

      <div
        id="tasklist"
        ref={scrollRef}
        onScroll={handleListScroll}
        onWheel={handleListWheel}
        className={
          vertical
            ? "mt-1 grid grid-cols-1 gap-4 w-full p-2 justify-items-center md:grid-cols-2 md:justify-items-center lg:flex lg:flex-row lg:items-start lg:gap-5 lg:overflow-x-auto lg:p-0 lg:w-full lg:min-w-0"
            : "mt-1 grid grid-cols-1 gap-4 w-full p-2 justify-items-center md:grid-cols-2 md:justify-items-center lg:flex lg:flex-row lg:items-start lg:gap-5 lg:overflow-x-auto lg:p-0 lg:w-full lg:min-w-0"
        }
      >
        {visibleTasks.map((elem) => {
          const taskId = getTaskId(elem);
          const isHighlighted = highlightedTaskId === taskId;

          return (
            <div
              key={taskId}
              data-task-id={taskId}
              className={`w-full max-w-[300px] md:w-full md:max-w-[300px] flex-shrink-0 transition-all duration-500 ${
                isHighlighted
                  ? "scale-110 z-10 shadow-2xl ring-4 ring-yellow-400 ring-opacity-75"
                  : "scale-100"
              }`}
            >
              {/* Render the correct task tile */}
              {elem.active ? (
                <AcceptTask
                  data={{ ...elem, email: data.email }}
                  onStatusChange={onAccept}
                  onExplain={() => handleExplain(elem)}
                  insightTeaser={
                    elem.explainSummary ||
                    (explainedTaskIds.has(taskId)
                      ? "AI checklist and sub-steps are ready. Click to open."
                      : "")
                  }
                  theme={theme}
                />
              ) : elem.newTask || elem.notAccepted ? (
                <NewTask
                  data={{ ...elem, email: data.email }}
                  onAccept={onAccept}
                  theme={theme}
                />
              ) : elem.completed ? (
                <CompleteTask
                  data={{ ...elem, email: data.email }}
                  onDelete={onAccept}
                  theme={theme}
                />
              ) : elem.failed ? (
                <FailedTask
                  data={{ ...elem, email: data.email }}
                  onDelete={onAccept}
                  theme={theme}
                />
              ) : null}
            </div>
          );
        })}
        {visibleTasks.length === 0 && (
          <div
            className={`w-full rounded-lg border p-6 text-center text-sm ${
              theme === "dark"
                ? "border-white/10 bg-white/[0.04] text-gray-300"
                : "border-gray-200 bg-gray-50 text-gray-600"
            }`}
          >
            No tasks match this filter.
          </div>
        )}
      </div>

      <ExplainTaskModal
        isOpen={modalOpen}
        onClose={handleCloseModal}
        explanation={explanation}
        loading={modalLoading}
        error={modalError}
        taskKey={currentTaskId}
        theme={theme}
      />
    </>
  );
};

export default TaskList;
