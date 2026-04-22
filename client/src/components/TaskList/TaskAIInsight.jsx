import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Maximize2, X } from "lucide-react";

const TaskAIInsight = ({
  summary,
  steps = [],
  estimatedTime,
  theme = "dark",
}) => {
  const [isExpandedModalOpen, setIsExpandedModalOpen] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [hasOverflow, setHasOverflow] = useState(false);
  const contentRef = useRef(null);

  useEffect(() => {
    const measureOverflow = () => {
      if (!contentRef.current) return;
      setHasOverflow(
        contentRef.current.scrollHeight > contentRef.current.clientHeight + 2,
      );
    };

    measureOverflow();
    window.addEventListener("resize", measureOverflow);
    return () => window.removeEventListener("resize", measureOverflow);
  }, [summary, steps, estimatedTime]);

  if (!summary) return null;

  const containerClass =
    theme === "dark"
      ? "mt-3 bg-black/25 backdrop-blur-sm border border-white/15 rounded-xl p-3 text-white shadow-sm hover:border-cyan-200/70 hover:shadow-cyan-300/15"
      : "mt-3 bg-white/90 backdrop-blur-sm border border-gray-200 rounded-xl p-3 text-gray-900 shadow-sm hover:border-gray-400 hover:shadow-gray-300/60";

  useEffect(() => {
    if (!isExpandedModalOpen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const handleEsc = (event) => {
      if (event.key === "Escape") {
        setIsExpandedModalOpen(false);
      }
    };

    window.addEventListener("keydown", handleEsc);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleEsc);
    };
  }, [isExpandedModalOpen]);

  const renderContent = (expandedView = false) => (
    <>
      <p
        className={`text-xs uppercase tracking-normal font-semibold ${
          theme === "dark" ? "opacity-80" : "opacity-90"
        }`}
      >
        AI Guidance
      </p>
      <p
        className={`text-sm mt-1.5 leading-relaxed ${
          theme === "dark" ? "opacity-95" : "opacity-100"
        }`}
      >
        {summary}
      </p>
      {Array.isArray(steps) && steps.length > 0 && (
        <ul
          className={`text-xs mt-2 space-y-1.5 list-disc list-inside ${
            theme === "dark" ? "opacity-90" : "opacity-95"
          }`}
        >
          {steps.slice(0, expandedView ? steps.length : 4).map((step, idx) => (
            <li key={idx} className="leading-relaxed">
              {step}
            </li>
          ))}
        </ul>
      )}
      {estimatedTime && (
        <p
          className={`text-[11px] mt-2 ${
            theme === "dark" ? "opacity-75" : "opacity-80"
          }`}
        >
          Estimated time: {estimatedTime}
        </p>
      )}
    </>
  );

  return (
    <>
      <div
        className={`${containerClass} group relative w-full transition-all duration-300 ease-in-out`}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        <div ref={contentRef} className="max-h-[146px] overflow-hidden pr-5">
          {renderContent(false)}
        </div>

        <div
          className={`pointer-events-none absolute inset-x-0 bottom-0 h-12 rounded-b-xl ${
            theme === "dark"
              ? "bg-gradient-to-t from-black/70 to-transparent"
              : "bg-gradient-to-t from-white/95 to-transparent"
          }`}
        />

        {hasOverflow && (
          <button
            type="button"
            onClick={() => setIsExpandedModalOpen(true)}
            aria-label="Expand AI guidance"
            className={`absolute bottom-2 right-2 flex h-7 w-7 items-center justify-center rounded-md border transition-all duration-200 ${
              theme === "dark"
                ? "border-white/20 bg-black/65 text-white shadow-sm hover:bg-black/90 hover:shadow-cyan-200/30"
                : "border-gray-200 bg-white text-gray-700 shadow-sm hover:bg-gray-100 hover:shadow-md"
            } opacity-80 ${isHovered ? "opacity-100 scale-105" : ""} active:scale-95`}
          >
            <Maximize2 size={14} />
          </button>
        )}
      </div>

      {isExpandedModalOpen &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            className="fixed inset-0 z-[120] flex items-center justify-center bg-black/35 backdrop-blur-[2px] p-4"
            onClick={() => setIsExpandedModalOpen(false)}
          >
            <div
              className={`relative w-full max-w-2xl rounded-2xl border overflow-visible shadow-2xl ${
                theme === "dark"
                  ? "border-white/15 bg-[#1b1b1b] text-white"
                  : "border-gray-200 bg-white text-gray-900"
              }`}
              onClick={(event) => event.stopPropagation()}
            >
              <div
                className={`flex items-center justify-between px-4 py-3 border-b rounded-t-2xl ${
                  theme === "dark" ? "border-white/10" : "border-gray-200"
                }`}
              >
                <h4 className="text-sm font-semibold">AI Guidance Overview</h4>
                <button
                  type="button"
                  onClick={() => setIsExpandedModalOpen(false)}
                  aria-label="Close expanded AI guidance"
                  className={`relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border transition-colors ${
                    theme === "dark"
                      ? "border-white/20 bg-white/10 text-white hover:bg-white/20"
                      : "border-gray-300 bg-white text-gray-700 hover:bg-gray-100"
                  }`}
                >
                  <X size={14} />
                </button>
              </div>

              <div className="max-h-[70vh] overflow-y-auto px-4 py-3 rounded-b-2xl">
                {renderContent(true)}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
};

export default TaskAIInsight;
