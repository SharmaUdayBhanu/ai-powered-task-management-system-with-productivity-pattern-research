import { useEffect, useMemo, useState } from "react";

const parseDurationMinutes = (value) => {
  const text = String(value || "")
    .toLowerCase()
    .trim();
  if (!text) return 0;

  const rangeMatch = text.match(
    /(\d+(?:\.\d+)?)\s*(?:-|to|\u2013)\s*(\d+(?:\.\d+)?)/,
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

const getDateDeadlineMs = (task = {}) => {
  if (!task.taskDate) return null;
  const dateDeadline = new Date(task.taskDate);
  if (Number.isNaN(dateDeadline.getTime())) return null;

  if (
    typeof task.taskDate === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(task.taskDate)
  ) {
    dateDeadline.setHours(23, 59, 59, 999);
  }

  return dateDeadline.getTime();
};

const getAcceptanceDeadlineMs = (task = {}) => {
  if (task.acceptanceDeadline) {
    const parsed = new Date(task.acceptanceDeadline).getTime();
    if (!Number.isNaN(parsed)) return parsed;
  }

  const limitMinutes = Number(task.acceptanceTimeLimitMinutes);
  const assignedAtMs = task.assignedAt
    ? new Date(task.assignedAt).getTime()
    : Number.NaN;
  if (!Number.isNaN(assignedAtMs) && limitMinutes > 0) {
    return assignedAtMs + limitMinutes * 60 * 1000;
  }

  return getDateDeadlineMs(task);
};

const getStartTimeMs = (task = {}) => {
  const source = task.startedAt || task.acceptedAt || task.assignedAt;
  if (!source) return null;
  const parsed = new Date(source).getTime();
  return Number.isNaN(parsed) ? null : parsed;
};

const getTaskRisk = (task = {}, now = Date.now()) => {
  if (task.failed) {
    return {
      label: "Critical",
      detail: "Task has failed and needs review.",
      className: "bg-red-600 text-white border-red-200/60",
    };
  }

  if (task.completed) {
    return {
      label: "Safe",
      detail: "Task is already completed.",
      className: "bg-emerald-600 text-white border-emerald-200/60",
    };
  }

  if (task.notAccepted) {
    return {
      label: "Critical",
      detail: "Acceptance window was missed.",
      className: "bg-red-600 text-white border-red-200/60",
    };
  }

  const estimatedMinutes =
    Number(task.estimatedDuration) ||
    parseDurationMinutes(task.explainEstimatedTime) ||
    60;
  const estimatedMs = estimatedMinutes * 60 * 1000;
  const startTimeMs = getStartTimeMs(task);
  const deadlineMs =
    startTimeMs && estimatedMinutes > 0
      ? startTimeMs + estimatedMs
      : getAcceptanceDeadlineMs(task);

  if (!deadlineMs) {
    return {
      label: "Safe",
      detail: "No urgent deadline signal is available.",
      className: "bg-emerald-600 text-white border-emerald-200/60",
    };
  }

  const remainingMs = deadlineMs - now;
  const elapsedMs = startTimeMs ? Math.max(now - startTimeMs, 0) : 0;
  const progressRatio = estimatedMs > 0 ? elapsedMs / estimatedMs : 0;
  const criticalWindowMs = Math.min(15 * 60 * 1000, estimatedMs * 0.15);
  const riskWindowMs = Math.min(45 * 60 * 1000, estimatedMs * 0.35);

  if (remainingMs <= 0 || remainingMs <= criticalWindowMs) {
    return {
      label: "Critical",
      detail:
        remainingMs <= 0
          ? "Deadline has passed."
          : "Deadline is very close.",
      className: "bg-red-600 text-white border-red-200/60",
    };
  }

  if (remainingMs <= riskWindowMs || progressRatio >= 0.7) {
    return {
      label: "At Risk",
      detail: "Deadline may be missed without attention.",
      className: "bg-yellow-300 text-yellow-950 border-yellow-100/80",
    };
  }

  return {
    label: "Safe",
    detail: "Task is on track.",
    className: "bg-emerald-600 text-white border-emerald-200/60",
  };
};

const TaskRiskBadge = ({ task }) => {
  const [now, setNow] = useState(Date.now());
  const isClosed = Boolean(
    task?.completed ||
      task?.failed ||
      task?.closed ||
      task?.isClosed ||
      task?.isDeleted ||
      task?.notAccepted,
  );
  const shouldShowRisk = Boolean(task?.active && !isClosed);

  const hasLiveDeadline = Boolean(shouldShowRisk);

  useEffect(() => {
    if (!hasLiveDeadline) return;
    const intervalId = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(intervalId);
  }, [hasLiveDeadline]);

  const risk = useMemo(() => getTaskRisk(task, now), [task, now]);

  if (!shouldShowRisk) return null;

  return (
    <span
      title={risk.detail}
      className={`inline-flex items-center rounded-full border px-2 py-1 text-[10px] font-semibold ${risk.className}`}
    >
      {risk.label}
    </span>
  );
};

export default TaskRiskBadge;
