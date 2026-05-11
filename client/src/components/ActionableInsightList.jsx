import React from "react";
import DataSourceBadge from "./DataSourceBadge";

const getInsightAction = (message) => {
  const text = String(message || "").trim();
  const lower = text.toLowerCase();

  if (/overload|too many|workload|burnout|capacity|active tasks/.test(lower)) {
    return {
      label: "Reduce workload",
      tone: "red",
    };
  }

  if (/underutil|assign more|take more|more tasks|available|low workload/.test(lower)) {
    return {
      label: "Assign more tasks",
      tone: "sky",
    };
  }

  if (/declin|drop|fall|risk|failed|failure|low completion|below|needs attention/.test(lower)) {
    return {
      label: "Performance declining",
      tone: "amber",
    };
  }

  if (/delay|late|deadline|overdue|blocker|handoff/.test(lower)) {
    return {
      label: "Fix delivery blockers",
      tone: "amber",
    };
  }

  if (/coach|support|training|mentor|review/.test(lower)) {
    return {
      label: "Coach employee",
      tone: "violet",
    };
  }

  if (/improv|top performer|leading|strong|high|reliable|on-time|consistent delivery/.test(lower)) {
    return {
      label: "Reinforce strong performance",
      tone: "emerald",
    };
  }

  if (/stable|steady|normal|balanced|consistent/.test(lower)) {
    return {
      label: "Performance stable",
      tone: "emerald",
    };
  }

  if (/priority|prioritize|focus/.test(lower)) {
    return {
      label: "Prioritize key tasks",
      tone: "cyan",
    };
  }

  return {
    label: "Review productivity signal",
    tone: "slate",
  };
};

const toneClasses = {
  red: {
    dark: "border-red-400/30 bg-red-500/15 text-red-200",
    light: "border-red-200 bg-red-50 text-red-700",
    dot: "bg-red-400",
  },
  amber: {
    dark: "border-yellow-400/30 bg-yellow-500/15 text-yellow-100",
    light: "border-yellow-200 bg-yellow-50 text-yellow-800",
    dot: "bg-yellow-400",
  },
  sky: {
    dark: "border-sky-400/30 bg-sky-500/15 text-sky-100",
    light: "border-sky-200 bg-sky-50 text-sky-800",
    dot: "bg-sky-400",
  },
  emerald: {
    dark: "border-emerald-400/30 bg-emerald-500/15 text-emerald-100",
    light: "border-emerald-200 bg-emerald-50 text-emerald-800",
    dot: "bg-emerald-400",
  },
  violet: {
    dark: "border-violet-400/30 bg-violet-500/15 text-violet-100",
    light: "border-violet-200 bg-violet-50 text-violet-800",
    dot: "bg-violet-400",
  },
  cyan: {
    dark: "border-cyan-400/30 bg-cyan-500/15 text-cyan-100",
    light: "border-cyan-200 bg-cyan-50 text-cyan-800",
    dot: "bg-cyan-400",
  },
  slate: {
    dark: "border-white/10 bg-white/10 text-white",
    light: "border-gray-200 bg-white text-gray-800",
    dot: "bg-gray-400",
  },
};

const dedupeInsights = (items) => {
  const seen = new Set();
  return items.filter((item) => {
    const key = String(item || "").trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const ActionableInsightList = ({
  items = [],
  fallbackItems = [],
  limit = 4,
  theme = "dark",
  source = "System",
}) => {
  const displayItems = dedupeInsights(items.length ? items : fallbackItems)
    .slice(0, limit)
    .map((item) => ({
      source: String(item || "").trim(),
      ...getInsightAction(item),
    }));

  if (!displayItems.length) {
    return (
      <div className="text-xs opacity-70">
        No productivity signals available yet.
      </div>
    );
  }

  return (
    <div className="flex flex-wrap gap-2">
      {displayItems.map((item, idx) => {
        const tone = toneClasses[item.tone] || toneClasses.slate;
        return (
          <span
            key={`${item.label}-${idx}`}
            title={item.source}
            className={`inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-[11px] font-semibold ${
              theme === "dark" ? tone.dark : tone.light
            }`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} />
            <span className="truncate">{item.label}</span>
            <DataSourceBadge source={source} className="ml-0" />
          </span>
        );
      })}
    </div>
  );
};

export default ActionableInsightList;
