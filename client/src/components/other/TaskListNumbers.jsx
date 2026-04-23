import React from "react";
import {
  BadgePlus,
  CheckCircle2,
  TriangleAlert,
  Zap,
} from "lucide-react";

const TaskListNumbers = ({ data, theme = "dark" }) => {
  const cards = [
    {
      key: "newTask",
      label: "New Tasks",
      value: data?.taskCounts?.newTask || 0,
      icon: BadgePlus,
      iconClassName: "text-cyan-300",
      tone: "from-indigo-500/70 to-cyan-500/70",
      hint: "Pending acceptance",
    },
    {
      key: "active",
      label: "In Progress",
      value: data?.taskCounts?.active || 0,
      icon: Zap,
      iconClassName: "text-sky-300",
      tone: "from-blue-500/70 to-sky-500/70",
      hint: "Tasks underway",
    },
    {
      key: "completed",
      label: "Completed",
      value: data?.taskCounts?.completed || 0,
      icon: CheckCircle2,
      iconClassName: "text-emerald-300",
      tone: "from-emerald-500/70 to-green-500/70",
      hint: "Great momentum",
    },
    {
      key: "failed",
      label: "Failed",
      value: data?.taskCounts?.failed || 0,
      icon: TriangleAlert,
      iconClassName: "text-orange-300",
      tone: "from-rose-500/70 to-orange-500/70",
      hint: "Needs attention",
    },
  ];

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {cards.map((card) => (
        (() => {
          const Icon = card.icon;
          return (
        <article
          key={card.key}
          className={`rounded-xl border p-4 ${
            theme === "dark"
              ? "border-white/10 bg-[#121212] text-white"
              : "border-gray-200 bg-white text-gray-900"
          }`}
        >
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs uppercase tracking-wide opacity-70">
                {card.label}
              </p>
              <p className="mt-1 text-3xl font-semibold">{card.value}</p>
            </div>
            <span
              className={`rounded-md p-1 ${
                theme === "dark" ? "bg-white/5" : "bg-gray-100"
              }`}
              aria-hidden="true"
            >
              <Icon size={20} className={card.iconClassName} />
            </span>
          </div>
          <div
            className={`mt-3 h-2 rounded-full bg-gradient-to-r ${card.tone}`}
          />
          <p className="mt-2 text-xs opacity-70">{card.hint}</p>
        </article>
          );
        })()
      ))}
    </div>
  );
};

export default TaskListNumbers;
