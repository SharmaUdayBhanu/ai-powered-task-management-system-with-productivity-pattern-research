import React, { useEffect, useMemo, useState } from "react";

const ExplainTaskModal = ({
  isOpen,
  onClose,
  explanation,
  loading,
  error,
  taskKey,
  theme = "dark",
}) => {
  // Prevent body scroll when modal is open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "unset";
    }
    return () => {
      document.body.style.overflow = "unset";
    };
  }, [isOpen]);

  const isDark = theme === "dark";
  const bgClass = isDark ? "bg-gray-800" : "bg-white";
  const textClass = isDark ? "text-gray-100" : "text-gray-900";
  const textSecondaryClass = isDark ? "text-gray-300" : "text-gray-600";
  const borderClass = isDark ? "border-gray-700" : "border-gray-200";
  const closeBtnClass = isDark
    ? "text-gray-400 hover:text-gray-200"
    : "text-gray-500 hover:text-gray-800";
  const checklistStorageKey = `modal-ai-checklist:${taskKey || "unknown"}`;

  const checklistItems = useMemo(() => {
    const steps = Array.isArray(explanation?.steps)
      ? explanation.steps
          .map((step) => String(step || "").trim())
          .filter(Boolean)
      : [];
    return steps.map((text, idx) => ({
      id: `${idx}-${text.toLowerCase().replace(/\s+/g, "-").slice(0, 48)}`,
      text,
    }));
  }, [explanation?.steps]);

  const [checkedMap, setCheckedMap] = useState({});

  useEffect(() => {
    try {
      const parsed = JSON.parse(
        localStorage.getItem(checklistStorageKey) || "{}",
      );
      setCheckedMap(parsed && typeof parsed === "object" ? parsed : {});
    } catch {
      setCheckedMap({});
    }
  }, [checklistStorageKey, taskKey, isOpen]);

  const toggleChecklistItem = (itemId) => {
    setCheckedMap((prev) => {
      const next = {
        ...prev,
        [itemId]: !prev?.[itemId],
      };
      try {
        localStorage.setItem(checklistStorageKey, JSON.stringify(next));
      } catch {
        // ignore storage failures
      }
      return next;
    });
  };

  const completedCount = checklistItems.filter(
    (item) => checkedMap[item.id],
  ).length;

  if (!isOpen) return null;

  const handleBackdropClick = (e) => {
    // Prevent closing on backdrop click - only close v
    // ia close button
    if (e.target === e.currentTarget) {
      // Do nothing - modal stays open
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={handleBackdropClick}
    >
      <div
        className={`${bgClass} ${textClass} rounded-lg shadow-2xl max-w-4xl w-full mx-4 flex flex-col border ${borderClass}`}
        style={{
          height: "85vh",
          maxHeight: "85vh",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Fixed Header */}
        <div
          className={`flex justify-between items-center p-6 pb-4 flex-shrink-0 border-b ${borderClass}`}
        >
          <h2 className={`text-xl font-semibold ${textClass}`}>Explain Task</h2>
          <button
            onClick={onClose}
            className={`${closeBtnClass} text-xl font-bold w-8 h-8 flex items-center justify-center rounded-full hover:bg-black/10 transition-colors`}
          >
            ×
          </button>
        </div>

        {/* Scrollable Content Area - Fixed height prevents layout shifts */}
        <div
          className="overflow-y-auto px-6 py-4"
          style={{
            height: "calc(85vh - 80px)", // Fixed height: total height minus header
            scrollbarGutter: "stable",
            overflowY: "auto",
          }}
        >
          {loading && (
            <div className="space-y-4">
              {/* Skeleton for Summary */}
              <div
                className={`p-4 rounded-lg ${isDark ? "bg-gray-700/50" : "bg-gray-50"} border ${borderClass}`}
              >
                <div
                  className={`h-4 w-24 mb-3 rounded ${isDark ? "bg-gray-600 animate-pulse" : "bg-gray-200 animate-pulse"}`}
                ></div>
                <div className="space-y-2">
                  <div
                    className={`h-3 rounded ${isDark ? "bg-gray-600 animate-pulse" : "bg-gray-200 animate-pulse"}`}
                    style={{ width: "100%" }}
                  ></div>
                  <div
                    className={`h-3 rounded ${isDark ? "bg-gray-600 animate-pulse" : "bg-gray-200 animate-pulse"}`}
                    style={{ width: "95%" }}
                  ></div>
                  <div
                    className={`h-3 rounded ${isDark ? "bg-gray-600 animate-pulse" : "bg-gray-200 animate-pulse"}`}
                    style={{ width: "85%" }}
                  ></div>
                </div>
              </div>
              {/* Skeleton for Steps */}
              <div
                className={`p-4 rounded-lg ${isDark ? "bg-gray-700/50" : "bg-gray-50"} border ${borderClass}`}
              >
                <div
                  className={`h-4 w-32 mb-3 rounded ${isDark ? "bg-gray-600 animate-pulse" : "bg-gray-200 animate-pulse"}`}
                ></div>
                <ul className="space-y-3">
                  {[1, 2, 3].map((idx) => (
                    <li key={idx} className="flex items-start gap-2">
                      <div
                        className={`w-1.5 h-1.5 rounded-full mt-2 ${isDark ? "bg-gray-500" : "bg-gray-400"}`}
                      ></div>
                      <div className="flex-1 space-y-2">
                        <div
                          className={`h-3 rounded ${isDark ? "bg-gray-600 animate-pulse" : "bg-gray-200 animate-pulse"}`}
                          style={{ width: "100%" }}
                        ></div>
                        <div
                          className={`h-3 rounded ${isDark ? "bg-gray-600 animate-pulse" : "bg-gray-200 animate-pulse"}`}
                          style={{ width: "90%" }}
                        ></div>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {error && (
            <div
              className={`text-sm ${isDark ? "text-red-400" : "text-red-600"} mb-4 p-3 rounded-lg ${isDark ? "bg-red-900/20" : "bg-red-50"} border ${isDark ? "border-red-800" : "border-red-200"}`}
            >
              {error || "Failed to fetch explanation."}
            </div>
          )}

          {!loading && explanation && (
            <>
              <div
                className={`mb-4 p-4 rounded-lg ${isDark ? "bg-gray-700/50" : "bg-gray-50"} border ${borderClass}`}
              >
                <h3 className={`font-semibold text-sm mb-2 ${textClass}`}>
                  Summary:
                </h3>
                <p className={`text-sm leading-relaxed ${textSecondaryClass}`}>
                  {explanation.summary}
                </p>
              </div>
              {checklistItems.length > 0 && (
                <div
                  className={`mb-4 p-4 rounded-lg ${isDark ? "bg-gray-700/50" : "bg-gray-50"} border ${borderClass}`}
                >
                  <div className="flex items-center justify-between">
                    <h3 className={`font-semibold text-sm ${textClass}`}>
                      Suggested steps:
                    </h3>
                    <span
                      className={`text-xs font-medium ${textSecondaryClass}`}
                    >
                      {completedCount}/{checklistItems.length} done
                    </span>
                  </div>

                  <ul className="mt-3 space-y-2">
                    {checklistItems.map((item, idx) => (
                      <li key={item.id}>
                        <label
                          className={`flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-sm transition-colors ${
                            isDark
                              ? "border-gray-600 bg-gray-800/60 hover:bg-gray-800"
                              : "border-gray-200 bg-white hover:bg-gray-100"
                          }`}
                        >
                          <span
                            className={`mt-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${isDark ? "bg-gray-600 text-gray-200" : "bg-gray-200 text-gray-700"}`}
                          >
                            {idx + 1}
                          </span>
                          <input
                            type="checkbox"
                            checked={Boolean(checkedMap[item.id])}
                            onChange={() => toggleChecklistItem(item.id)}
                            className="mt-0.5 h-4 w-4 rounded"
                          />
                          <span
                            className={`leading-relaxed ${
                              checkedMap[item.id]
                                ? isDark
                                  ? "text-gray-400 line-through"
                                  : "text-gray-500 line-through"
                                : textSecondaryClass
                            }`}
                          >
                            {item.text}
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {explanation.estimated_time && (
                <div
                  className={`text-xs ${textSecondaryClass} mt-4 pt-3 border-t ${borderClass}`}
                >
                  <span className="font-semibold">Estimated time:</span>{" "}
                  {explanation.estimated_time}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default ExplainTaskModal;
