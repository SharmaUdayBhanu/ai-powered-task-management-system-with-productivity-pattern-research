import React, { useState } from "react";
import axios from "axios";
import { Users } from "lucide-react";
import EmployeeAutocomplete, {
  EmployeeMultiSelect,
  isKnownEmployeeEmail,
} from "../EmployeeAutocomplete";

const API_URL = `${import.meta.env.VITE_API_URL || ""}/api`;

/** Matches server: due date YYYY-MM-DD vs UTC calendar "today". */
function utcCalendarTodayStr() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const mo = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${d}`;
}

function isTaskDueDatePastUtc(taskDateValue) {
  const str = String(taskDateValue || "").trim();
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const picked = new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])),
  );
  if (Number.isNaN(picked.getTime())) return false;
  const now = new Date();
  const todayUtc = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  return picked.getTime() < todayUtc.getTime();
}

const CreateTask = ({ onTaskCreated, theme, employees = [] }) => {
  const [form, setForm] = useState({
    email: "",
    taskTitle: "",
    taskDescription: "",
    taskDate: "",
    category: "",
    acceptanceTimeLimitMinutes: "60",
  });
  const [groupEmails, setGroupEmails] = useState([]);
  const [isGroupTask, setIsGroupTask] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState("");

  const handleChange = (e) => {
    setForm({ ...form, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    setSuccess("");
    try {
      if (!isGroupTask && !isKnownEmployeeEmail(employees, form.email)) {
        setError("No matching employee found");
        return;
      }

      if (isGroupTask && groupEmails.length < 2) {
        setError("Select at least two valid employees for a group task");
        return;
      }

      if (form.taskDate && isTaskDueDatePastUtc(form.taskDate)) {
        setError("Task due date cannot be in the past.");
        return;
      }

      const newTask = {
        taskTitle: form.taskTitle,
        taskDescription: form.taskDescription,
        taskDate: form.taskDate,
        category: form.category,
        acceptanceTimeLimitMinutes:
          Number(form.acceptanceTimeLimitMinutes) || 0,
        newTask: true,
        active: false,
        completed: false,
        failed: false,
      };

      let response;
      if (isGroupTask) {
        response = await axios.post(`${API_URL}/group-tasks`, {
          ...newTask,
          emails: groupEmails,
        });
      } else {
        response = await axios.post(
          `${API_URL}/employees/${form.email}/tasks`,
          newTask,
        );
      }
      setForm({
        email: "",
        taskTitle: "",
        taskDescription: "",
        taskDate: "",
        category: "",
        acceptanceTimeLimitMinutes: "60",
      });
      setGroupEmails([]);
      setSuccess(
        isGroupTask
          ? "Group task assigned successfully!"
          : "Task assigned successfully!",
      );
      setTimeout(() => setSuccess(""), 3000);
      if (onTaskCreated) {
        onTaskCreated({
          isGroupTask,
          email: form.email,
          groupEmails,
          responseData: response?.data,
        });
      }
      return;
    } catch (err) {
      const apiMsg = err?.response?.data?.error;
      setError(
        typeof apiMsg === "string" && apiMsg.trim()
          ? apiMsg.trim()
          : "Employee not found or error creating task",
      );
    } finally {
      setLoading(false);
    }
  };

  const inputClass =
    theme === "dark"
      ? "w-full rounded-lg border border-white/10 bg-[#111] px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/60 focus:ring-2 focus:ring-cyan-300/10"
      : "w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 outline-none focus:border-cyan-400 focus:ring-2 focus:ring-cyan-100";

  return (
    <form onSubmit={handleSubmit} className="space-y-3 md:space-y-4">
      <label
        className={`flex items-center justify-between rounded-lg border px-3 py-2 text-sm ${theme === "dark" ? "border-white/10 bg-white/5 text-white" : "border-gray-200 bg-gray-50 text-gray-900"}`}
        title="Assign the same task to multiple employees and track shared acceptance."
      >
        <span className="flex items-center gap-2 font-semibold">
          <Users size={16} />
          Group Task
        </span>
        <input
          type="checkbox"
          checked={isGroupTask}
          onChange={(event) => setIsGroupTask(event.target.checked)}
          className="h-4 w-4"
        />
      </label>
      {!isGroupTask ? (
        <EmployeeAutocomplete
          employees={employees}
          value={form.email}
          onChange={(email) => setForm((prev) => ({ ...prev, email }))}
          placeholder="Employee name or email"
          theme={theme}
          required
        />
      ) : (
        <EmployeeMultiSelect
          employees={employees}
          selectedEmails={groupEmails}
          onChange={setGroupEmails}
          theme={theme}
        />
      )}
      <input
        type="text"
        name="taskTitle"
        value={form.taskTitle}
        onChange={handleChange}
        placeholder="Task Title"
        className={inputClass}
        required
      />
      <textarea
        name="taskDescription"
        value={form.taskDescription}
        onChange={handleChange}
        placeholder="Task Description"
        className={`${inputClass} min-h-28 resize-y`}
        required
      />
      <input
        type="date"
        name="taskDate"
        min={utcCalendarTodayStr()}
        value={form.taskDate}
        onChange={handleChange}
        className={inputClass}
        required
      />
      <input
        type="text"
        name="category"
        value={form.category}
        onChange={handleChange}
        placeholder="Category"
        className={inputClass}
        required
      />
      <input
        type="number"
        name="acceptanceTimeLimitMinutes"
        value={form.acceptanceTimeLimitMinutes}
        onChange={handleChange}
        placeholder="Acceptance time limit (minutes)"
        min="1"
        step="1"
        className={inputClass}
        required
      />
      {error && <div className="text-red-500">{error}</div>}
      {success && <div className="text-green-500">{success}</div>}
      <button
        type="submit"
        className={
          theme === "dark"
            ? "w-full rounded-lg bg-cyan-500/25 px-4 py-2.5 text-sm font-semibold text-cyan-100 hover:bg-cyan-500/35 disabled:opacity-60 md:w-auto"
            : "w-full rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60 md:w-auto"
        }
        disabled={loading}
      >
        {loading ? "Creating..." : "Create Task"}
      </button>
    </form>
  );
};

export default CreateTask;
