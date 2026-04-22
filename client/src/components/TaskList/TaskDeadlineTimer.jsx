import { useEffect, useMemo, useState } from "react";

const formatDuration = (ms) => {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  return `${minutes}m ${seconds}s`;
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

const TaskDeadlineTimer = ({ task, theme = "dark" }) => {
  const [now, setNow] = useState(Date.now());

  const estimatedMinutes = Number(task?.estimatedDuration);
  const explainEstimatedMinutes = parseDurationMinutes(
    task?.explainEstimatedTime,
  );
  const resolvedEstimatedMinutes =
    estimatedMinutes > 0 ? estimatedMinutes : explainEstimatedMinutes;
  const estimationPending = Boolean(task?.aiEstimationPending);
  const acceptanceTimeLimitMinutes = Number(task?.acceptanceTimeLimitMinutes);

  const startTimeMs = useMemo(() => {
    const start = task?.startedAt || task?.acceptedAt || task?.assignedAt;
    if (!start) return null;
    const parsed = new Date(start).getTime();
    return Number.isNaN(parsed) ? null : parsed;
  }, [task?.startedAt, task?.acceptedAt, task?.assignedAt]);

  const deadlineMs =
    startTimeMs && resolvedEstimatedMinutes > 0
      ? startTimeMs + resolvedEstimatedMinutes * 60 * 1000
      : null;

  const acceptanceDeadlineMs = useMemo(() => {
    if (task?.acceptanceDeadline) {
      const parsed = new Date(task.acceptanceDeadline).getTime();
      if (!Number.isNaN(parsed)) return parsed;
    }

    const assignedAtMs = task?.assignedAt
      ? new Date(task.assignedAt).getTime()
      : Number.NaN;
    if (!Number.isNaN(assignedAtMs) && acceptanceTimeLimitMinutes > 0) {
      return assignedAtMs + acceptanceTimeLimitMinutes * 60 * 1000;
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
    task?.assignedAt,
    acceptanceTimeLimitMinutes,
    task?.taskDate,
  ]);

  useEffect(() => {
    const hasRunningCountdown =
      (task?.newTask && !task?.acceptedAt && acceptanceDeadlineMs) ||
      deadlineMs;

    if (!hasRunningCountdown) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [deadlineMs, acceptanceDeadlineMs, task?.newTask, task?.acceptedAt]);

  const badgeClass =
    theme === "dark"
      ? "text-[11px] font-semibold bg-black/20 text-white px-2 py-1 rounded"
      : "text-[11px] font-semibold bg-black/10 text-gray-800 px-2 py-1 rounded";

  if (task?.newTask && !task?.acceptedAt) {
    if (!resolvedEstimatedMinutes || resolvedEstimatedMinutes <= 0) {
      if (estimationPending) {
        return (
          <span className={badgeClass}>
            Estimated completion: Calculating...
          </span>
        );
      }
      return <span className={badgeClass}>Estimated completion: 60 min</span>;
    }

    return (
      <span className={badgeClass}>
        Estimated completion: {resolvedEstimatedMinutes} min
      </span>
    );
  }

  if (!resolvedEstimatedMinutes || resolvedEstimatedMinutes <= 0) {
    if (estimationPending) {
      return <span className={badgeClass}>Estimating...</span>;
    }
    return <span className={badgeClass}>Time limit: 60 min (fallback)</span>;
  }

  if (!deadlineMs) {
    return (
      <span className={badgeClass}>
        Time limit: {resolvedEstimatedMinutes} min (starts on accept)
      </span>
    );
  }

  const remainingMs = deadlineMs - now;

  if (remainingMs >= 0) {
    return (
      <span className={badgeClass}>
        Time left: {formatDuration(remainingMs)}
      </span>
    );
  }

  return (
    <span className={badgeClass}>
      Overdue by: {formatDuration(Math.abs(remainingMs))}
    </span>
  );
};

export default TaskDeadlineTimer;
