import { useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import TaskDeadlineTimer from "./TaskDeadlineTimer";

const API_URL = import.meta.env.VITE_API_URL + "/api";

const NewTask = ({ data, onAccept, theme = "dark" }) => {
  const [task, setTask] = useState(data);
  const [loading, setLoading] = useState(false);
  const [actionError, setActionError] = useState("");
  const [nowMs, setNowMs] = useState(Date.now());
  const expiryHandledRef = useRef(false);

  useEffect(() => {
    setTask(data);
  }, [data]);

  const isNotAccepted = Boolean(task?.notAccepted);

  const isSameTask = (candidate) =>
    (data._id && String(candidate._id || candidate.id) === String(data._id)) ||
    (candidate.taskTitle === data.taskTitle &&
      candidate.taskDate === data.taskDate &&
      candidate.taskDescription === data.taskDescription);

  const computeTaskCounts = (tasks = []) => ({
    newTask: tasks.filter((t) => t.newTask && !t.isDeleted).length,
    active: tasks.filter((t) => t.active && !t.isDeleted).length,
    completed: tasks.filter((t) => t.completed && !t.isDeleted).length,
    failed: tasks.filter((t) => t.failed && !t.isDeleted).length,
  });

  const acceptanceDeadlineMs = useMemo(() => {
    if (task?.acceptanceDeadline) {
      const parsed = new Date(task.acceptanceDeadline).getTime();
      if (!Number.isNaN(parsed)) return parsed;
    }

    const limitMinutes = Number(task?.acceptanceTimeLimitMinutes);
    const assignedAtMs = task?.assignedAt
      ? new Date(task.assignedAt).getTime()
      : Number.NaN;

    if (!Number.isNaN(assignedAtMs) && limitMinutes > 0) {
      return assignedAtMs + limitMinutes * 60 * 1000;
    }

    if (task?.taskDate) {
      const dateDeadline = new Date(task.taskDate);
      if (!Number.isNaN(dateDeadline.getTime())) {
        if (
          typeof task.taskDate === "string" &&
          /^\d{4}-\d{2}-\d{2}$/.test(task.taskDate)
        ) {
          dateDeadline.setHours(23, 59, 59, 999);
        }
        return dateDeadline.getTime();
      }
    }

    return null;
  }, [
    task?.acceptanceDeadline,
    task?.acceptanceTimeLimitMinutes,
    task?.assignedAt,
    task?.taskDate,
  ]);

  const isAcceptanceExpired =
    task?.newTask &&
    !task?.acceptedAt &&
    !task?.notAccepted &&
    acceptanceDeadlineMs &&
    nowMs > acceptanceDeadlineMs;

  useEffect(() => {
    if (!task?.newTask || task?.acceptedAt || task?.notAccepted) return;
    const intervalId = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, [task?.newTask, task?.acceptedAt, task?.notAccepted]);

  const markTaskAsNotAccepted = async () => {
    try {
      const res = await axios.get(`${API_URL}/employees/${data.email}`);
      const employee = res.data;
      const taskIndex = employee.tasks.findIndex(isSameTask);
      if (taskIndex === -1) return;

      const updatedTask = {
        ...employee.tasks[taskIndex],
        newTask: false,
        active: false,
        completed: false,
        failed: false,
        notAccepted: true,
      };

      const updatedTasks = [...employee.tasks];
      updatedTasks[taskIndex] = updatedTask;
      const updatedEmployee = {
        ...employee,
        tasks: updatedTasks,
        taskCounts: computeTaskCounts(updatedTasks),
      };

      await axios.put(
        `${API_URL}/employees/${employee.email}`,
        updatedEmployee,
      );
      setTask(updatedTask);
      if (onAccept) onAccept();
    } catch (err) {
      setActionError("Task acceptance window expired.");
    }
  };

  useEffect(() => {
    if (!isAcceptanceExpired || expiryHandledRef.current) return;
    expiryHandledRef.current = true;
    markTaskAsNotAccepted();
  }, [isAcceptanceExpired]);

  const acceptHandler = async () => {
    if (!task.newTask) return;
    setLoading(true);
    setActionError("");
    try {
      const res = await axios.get(`${API_URL}/employees/${data.email}`);
      const employee = res.data;
      const taskIndex = employee.tasks.findIndex(isSameTask);
      if (taskIndex === -1) return;
      const now = new Date();
      const updatedTask = {
        ...employee.tasks[taskIndex],
        newTask: false,
        active: true,
        completed: false,
        failed: false,
        completedAt: undefined,
        onTime: true,
        acceptedAt: now,
        startedAt: now,
      };
      const updatedTasks = [...employee.tasks];
      updatedTasks[taskIndex] = updatedTask;
      const updatedCounts = computeTaskCounts(updatedTasks);
      const updatedEmployee = {
        ...employee,
        tasks: updatedTasks,
        taskCounts: updatedCounts,
      };
      await axios.put(
        `${API_URL}/employees/${employee.email}`,
        updatedEmployee,
      );
      setTask(updatedTask);
      if (onAccept) onAccept();
    } catch (err) {
      setActionError("Unable to accept this task right now. Please retry.");
    } finally {
      setLoading(false);
    }
  };

  const updateTaskStatus = async (statusType) => {
    setLoading(true);
    setActionError("");
    try {
      const res = await axios.get(`${API_URL}/employees/${data.email}`);
      const employee = res.data;
      const taskIndex = employee.tasks.findIndex(isSameTask);
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
      const updatedCounts = computeTaskCounts(updatedTasks);
      const updatedEmployee = {
        ...employee,
        tasks: updatedTasks,
        taskCounts: updatedCounts,
      };
      await axios.put(
        `${API_URL}/employees/${employee.email}`,
        updatedEmployee,
      );
      setTask(updatedTask);
      if (onAccept) onAccept();
    } catch (err) {
      setActionError("Unable to update task status right now. Please retry.");
    } finally {
      setLoading(false);
    }
  };

  if (!task.newTask && task.active) {
    return (
      <div className="flex-shrink-0 w-full max-w-[280px] h-fit bg-gradient-to-br from-rose-500 via-red-500 to-orange-400 rounded-xl p-4 shadow-lg shadow-black/10 text-white flex flex-col overflow-visible transition-all duration-300 ease-in-out hover:shadow-2xl hover:shadow-black/20">
        <div className="flex justify-between items-center flex-shrink-0">
          <h3 className="bg-white text-red-600 px-3 py-1 rounded text-xs font-semibold">
            {task.category}
          </h3>
          <h4 className="text-sm">{task.taskDate}</h4>
        </div>
        <div className="flex justify-between items-center mt-2 flex-shrink-0">
          <span className="text-xs font-semibold bg-black/20 text-white px-2 py-1 rounded">
            AI Suggested Priority: {task.aiPriority || "Medium"}
          </span>
        </div>
        <div className="mt-2 flex justify-between items-center flex-shrink-0">
          <TaskDeadlineTimer task={task} theme={theme} />
        </div>
        <h2 className="mt-3 text-xl font-semibold flex-shrink-0 line-clamp-2">
          {task.taskTitle}
        </h2>
        <div className="overflow-visible">
          <p className="text-sm mt-3 leading-relaxed line-clamp-4">
            {task.taskDescription}
          </p>
          <TaskAIInsight
            summary={task.explainSummary}
            steps={task.explainSteps}
            estimatedTime={task.explainEstimatedTime}
            theme={theme}
          />
        </div>
        <div className="flex justify-between mt-4 gap-2 flex-shrink-0">
          <button
            onClick={() => updateTaskStatus("completed")}
            disabled={loading}
            className="bg-white text-green-600 py-1 px-2 text-sm rounded-lg border border-green-600 flex-1 hover:bg-green-50 hover:scale-[1.02] active:scale-[0.98] transition-all duration-200 disabled:opacity-50"
          >
            {loading ? "Updating..." : "Mark as completed"}
          </button>
          <button
            onClick={() => updateTaskStatus("failed")}
            disabled={loading}
            className="bg-white text-red-600 py-1 px-2 text-sm rounded-lg border border-red-600 flex-1 hover:bg-red-50 hover:scale-[1.02] active:scale-[0.98] transition-all duration-200 disabled:opacity-50"
          >
            {loading ? "Updating..." : "Mark as failed"}
          </button>
        </div>
        {onExplain && (
          <button
            onClick={onExplain}
            className="mt-3 h-8 w-full bg-white/90 text-red-700 text-xs font-semibold py-1.5 rounded-lg border border-red-600 hover:bg-white hover:scale-[1.02] active:scale-[0.98] transition-all duration-200 flex-shrink-0"
          >
            Explain Task (AI)
          </button>
        )}
        {!onExplain && (
          <div className="mt-3 h-8 flex-shrink-0" aria-hidden="true" />
        )}
      </div>
    );
  }

  return (
    <div
      className={`flex-shrink-0 w-full max-w-[280px] h-fit rounded-xl p-4 shadow-lg shadow-black/10 flex flex-col overflow-visible transition-all duration-300 ease-in-out ${
        isNotAccepted
          ? "bg-gradient-to-br from-gray-500 via-gray-600 to-gray-700 text-gray-200 opacity-75"
          : "bg-gradient-to-br from-sky-500 via-blue-500 to-indigo-500 text-white hover:shadow-2xl hover:shadow-black/20"
      }`}
    >
      <div className="flex justify-between items-center flex-shrink-0">
        <h3
          className={`px-3 py-1 rounded text-xs font-semibold ${
            isNotAccepted
              ? "bg-gray-200 text-gray-700"
              : "bg-white text-blue-600"
          }`}
        >
          {task.category}
        </h3>
        <h4 className="text-sm">{task.taskDate}</h4>
      </div>
      <div className="flex justify-between items-center mt-2 flex-shrink-0">
        <span
          className={`text-xs font-semibold px-2 py-1 rounded ${
            isNotAccepted
              ? "bg-black/20 text-gray-100"
              : "bg-black/10 text-white"
          }`}
        >
          AI Suggested Priority: {task.aiPriority || "Medium"}
        </span>
      </div>
      {!isNotAccepted && (
        <div className="mt-2 flex justify-between items-center flex-shrink-0">
          <TaskDeadlineTimer task={task} theme={theme} />
        </div>
      )}
      {isNotAccepted && (
        <div className="mt-2 rounded-md border border-gray-300/40 bg-black/20 px-2 py-1 text-xs font-semibold text-gray-100">
          Task not accepted
        </div>
      )}
      <h2 className="mt-3 text-xl font-semibold flex-shrink-0 line-clamp-2">
        {task.taskTitle}
      </h2>
      <div className="overflow-visible">
        <p className="text-sm mt-3 leading-relaxed line-clamp-4">
          {task.taskDescription}
        </p>
      </div>
      <div className="mt-4 flex flex-col gap-2 flex-shrink-0">
        {actionError && (
          <div className="text-xs font-medium rounded bg-red-600/20 border border-red-300/30 px-2 py-1">
            {actionError}
          </div>
        )}
        <button
          onClick={acceptHandler}
          className="bg-white text-green-600 p-2 rounded-lg border border-green-600 hover:bg-green-50 hover:scale-[1.02] active:scale-[0.98] transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed"
          disabled={
            !task.newTask || loading || isAcceptanceExpired || task.notAccepted
          }
        >
          {loading
            ? "Accepting..."
            : isAcceptanceExpired || task.notAccepted
              ? "Not Accepted (Expired)"
              : "Accept Task"}
        </button>
      </div>
    </div>
  );
};

export default NewTask;
