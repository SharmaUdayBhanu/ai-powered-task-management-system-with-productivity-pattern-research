import React, { useState } from "react";
import axios from "axios";
import TaskAIInsight from "./TaskAIInsight";

const API_URL = `${import.meta.env.VITE_API_URL || ""}/api`;

const FailedTask = ({ data, onExplain, onDelete, theme = "dark" }) => {
  const [loading, setLoading] = useState(false);

  const handleDelete = async () => {
    if (
      !window.confirm(
        "This task will be hidden from view but will still be included in productivity metrics. Continue?",
      )
    )
      return;
    setLoading(true);
    try {
      const res = await axios.get(`${API_URL}/employees/${data.email}`);
      const employee = res.data;
      const taskIndex = employee.tasks.findIndex(
        (t) =>
          t.taskTitle === data.taskTitle &&
          t.taskDate === data.taskDate &&
          t.taskDescription === data.taskDescription &&
          t.failed &&
          !t.isDeleted,
      );
      if (taskIndex === -1) return;

      // Mark as deleted instead of removing - keeps it in analytics
      const updatedTasks = [...employee.tasks];
      updatedTasks[taskIndex] = {
        ...updatedTasks[taskIndex],
        isDeleted: true,
        deletedAt: new Date(),
      };

      // Update counts for display (but task still exists for analytics)
      const updatedCounts = { ...employee.taskCounts };
      updatedCounts.failed = Math.max((updatedCounts.failed || 0) - 1, 0);

      const updatedEmployee = {
        ...employee,
        tasks: updatedTasks,
        taskCounts: updatedCounts,
      };
      await axios.put(
        `${API_URL}/employees/${employee.email}`,
        updatedEmployee,
      );
      if (onDelete) onDelete();
    } catch (err) {
      console.error("Failed to delete task:", err);
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="flex-shrink-0 w-full max-w-[280px] h-fit bg-gradient-to-br from-amber-400 via-orange-500 to-red-500 rounded-xl p-4 shadow-lg shadow-black/10 flex flex-col overflow-visible transition-all duration-300 ease-in-out hover:shadow-2xl hover:shadow-black/20">
      <div className="flex justify-between items-center flex-shrink-0">
        <h3 className="bg-white text-orange-700 px-3 py-1 rounded text-xs font-semibold">
          {data.category}
        </h3>
        <h4 className="text-sm">{data.taskDate}</h4>
      </div>
      <div className="flex justify-between items-center mt-2 flex-shrink-0">
        <span className="text-xs font-semibold bg-black/10 text-white px-2 py-1 rounded">
          AI Suggested Priority: {data.aiPriority || "Medium"}
        </span>
      </div>
      <h2 className="mt-3 text-xl font-semibold flex-shrink-0 line-clamp-2">
        {data.taskTitle}
      </h2>
      <div className="overflow-visible">
        <p className="text-sm mt-3 leading-relaxed line-clamp-4">
          {data.taskDescription}
        </p>
        <TaskAIInsight
          summary={data.explainSummary}
          steps={data.explainSteps}
          estimatedTime={data.explainEstimatedTime}
          theme={theme}
        />
      </div>
      <div className="mt-2 flex flex-col gap-2 flex-shrink-0">
        <button className="bg-white text-orange-700 w-full rounded-lg p-2 border border-orange-700 hover:bg-orange-50 hover:scale-[1.02] active:scale-[0.98] transition-all duration-200">
          Failed
        </button>
        <button
          onClick={handleDelete}
          disabled={loading}
          className="bg-red-500 text-white w-full rounded-lg p-2 border border-red-600 hover:bg-red-600 hover:scale-[1.02] active:scale-[0.98] transition-all duration-200 disabled:opacity-50 text-xs font-semibold"
        >
          {loading ? "Deleting..." : "Delete Task"}
        </button>
        {onExplain && (
          <button
            onClick={onExplain}
            className="w-full bg-white/90 text-orange-700 text-xs font-semibold py-1.5 rounded-lg border border-orange-700 hover:bg-white transition-all duration-200"
          >
            Explain Task (AI)
          </button>
        )}
      </div>
    </div>
  );
};

export default FailedTask;
