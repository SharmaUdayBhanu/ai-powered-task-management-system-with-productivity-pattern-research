import React from "react";
import DataSourceBadge from "./DataSourceBadge";

const inferTone = (text) => {
  const lower = String(text || "").toLowerCase();

  if (/overload|too many|burnout|capacity|context-switch|queue|parallel/.test(lower)) {
    return "red";
  }
  if (/underutil|low recent|bench|quiet week|no completions captured/.test(lower)) {
    return "sky";
  }
  if (/fail|risk|declin|drop|volatile|blocked|delay|late|deadline/.test(lower)) {
    return "amber";
  }
  if (/coach|support|training|mentor|review|checkpoint/.test(lower)) {
    return "violet";
  }
  if (/improv|strong|reliable|on-time|momentum|stable rhythm|win/.test(lower)) {
    return "emerald";
  }
  if (/priorit|focus|sequence|route|rebalance/.test(lower)) {
    return "cyan";
  }
  return "slate";
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

const normalizeItem = (item, listDefaultSource = "SYS") => {
  if (item == null) return null;
  if (typeof item === "object") {
    const headline = String(item.headline || item.title || "").trim();
    const rationale = String(
      item.rationale || item.why || item.reason || headline,
    ).trim();
    if (!headline && !rationale) return null;
    const display = headline || rationale.slice(0, 100);
    const explain = rationale || headline;
    let src = listDefaultSource;
    if (item.source === "ai" || item.source === "AI") src = "AI";
    else if (item.source === "sys" || item.source === "SYS") src = "SYS";
    return {
      key: `${display}-${explain.slice(0, 24)}`,
      label: display,
      title: explain,
      tone: inferTone(`${display} ${explain}`),
      source: src,
    };
  }
  const text = String(item || "").trim();
  if (!text) return null;
  return {
    key: text,
    label: text.length > 110 ? `${text.slice(0, 107)}…` : text,
    title: text,
    tone: inferTone(text),
    source: listDefaultSource,
  };
};

const dedupeItems = (items) => {
  const seen = new Set();
  return items.filter((row) => {
    const k = row.label.toLowerCase().replace(/\s+/g, " ").trim();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

const ActionableInsightList = ({
  items = [],
  fallbackItems = [],
  limit = 4,
  theme = "dark",
  source = "SYS",
}) => {
  const listDefault =
    source === "AI" || source === "ai" ? "AI" : "SYS";
  const raw = items.length ? items : fallbackItems;
  const normalized = dedupeItems(
    raw.map((item) => normalizeItem(item, listDefault)).filter(Boolean),
  ).slice(0, limit);

  if (!normalized.length) {
    return (
      <div className="text-xs opacity-70">
        No productivity signals available yet.
      </div>
    );
  }

  return (
    <div className="flex flex-wrap gap-2">
      {normalized.map((item, idx) => {
        const tone = toneClasses[item.tone] || toneClasses.slate;
        return (
          <span
            key={`${item.key}-${idx}`}
            title={item.title}
            className={`inline-flex max-w-full cursor-default items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-[11px] font-semibold leading-snug ${
              theme === "dark" ? tone.dark : tone.light
            }`}
          >
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot}`} />
            <span className="min-w-0 break-words text-left">{item.label}</span>
            <DataSourceBadge source={item.source} className="ml-0 shrink-0" />
          </span>
        );
      })}
    </div>
  );
};

export default ActionableInsightList;
