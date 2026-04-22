import React from "react";

const AdminProductivityLeaderboard = ({
  leaderboard = [],
  aiInsights,
  loading,
  error,
  theme = "dark",
}) => {
  const containerClass =
    theme === "dark"
      ? "mt-6 bg-[#111] border border-white/10 rounded-xl p-4"
      : "mt-6 bg-white border border-gray-200 rounded-xl p-4";

  const tableClass =
    theme === "dark"
      ? "w-full text-sm text-white/90"
      : "w-full text-sm text-gray-800";

  return (
    <div className={containerClass}>
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-lg font-semibold">Productivity Leaderboard</h2>
          <p className="text-xs opacity-70">
            Ranked by score = (completed × 2) − failed.
          </p>
        </div>
      </div>

      {loading && (
        <div className="text-xs opacity-70">Loading productivity data...</div>
      )}
      {error && <div className="text-xs text-red-400">{error}</div>}

      {!loading && !error && (
        <>
          <div className="overflow-x-auto">
            <table className={tableClass}>
              <thead>
                <tr
                  className={
                    theme === "dark" ? "text-white/70" : "text-gray-500"
                  }
                >
                  <th className="text-left py-2">Rank</th>
                  <th className="text-left py-2">Employee</th>
                  <th className="text-left py-2">On-time %</th>
                  <th className="text-left py-2">Avg mins</th>
                  <th className="text-left py-2">Last 7d</th>
                  <th className="text-left py-2">Trend</th>
                  <th className="text-left py-2">Score</th>
                </tr>
              </thead>
              <tbody>
                {leaderboard.map((entry, idx) => (
                  <tr
                    key={entry.employeeId}
                    className={
                      idx % 2 === 0
                        ? theme === "dark"
                          ? "bg-white/5"
                          : "bg-gray-50"
                        : ""
                    }
                  >
                    <td className="py-2 font-semibold">{idx + 1}</td>
                    <td className="py-2">
                      <div className="font-semibold">{entry.name}</div>
                      <div className="text-[11px] opacity-70">
                        {entry.email}
                      </div>
                    </td>
                    <td className="py-2">
                      {entry.stats.onTimePercent.toFixed(1)}%
                    </td>
                    <td className="py-2">
                      {entry.stats.averageCompletionTimeMinutes} min
                    </td>
                    <td className="py-2">{entry.stats.completedLast7Days}</td>
                    <td className="py-2">
                      {entry.stats.productivityTrendDelta >= 0 ? "+" : ""}
                      {entry.stats.productivityTrendDelta}
                    </td>
                    <td className="py-2 font-semibold">
                      {entry.productivityScore}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {aiInsights && (
            <div
              className={
                theme === "dark"
                  ? "mt-4 bg-white/5 border border-white/10 rounded-lg p-4"
                  : "mt-4 bg-gray-50 border border-gray-200 rounded-lg p-4"
              }
            >
              <h3
                className={`text-sm font-semibold mb-3 ${theme === "dark" ? "text-white" : "text-gray-900"}`}
              >
                AI Competitive Analysis for Admin
              </h3>

              {aiInsights.summary && (
                <p
                  className={`text-sm mb-3 ${theme === "dark" ? "text-gray-300" : "text-gray-700"}`}
                >
                  {aiInsights.summary}
                </p>
              )}

              {aiInsights.topPerformer && (
                <div
                  className={`mb-2 p-2 rounded ${theme === "dark" ? "bg-yellow-900/20" : "bg-yellow-50"}`}
                >
                  <span
                    className={`text-xs font-semibold ${theme === "dark" ? "text-yellow-400" : "text-yellow-700"}`}
                  >
                    🏆 Top Performer:{" "}
                  </span>
                  <span
                    className={`text-xs ${theme === "dark" ? "text-gray-300" : "text-gray-700"}`}
                  >
                    {aiInsights.topPerformer}
                  </span>
                </div>
              )}

              {aiInsights.mostImproved && (
                <div
                  className={`mb-2 p-2 rounded ${theme === "dark" ? "bg-green-900/20" : "bg-green-50"}`}
                >
                  <span
                    className={`text-xs font-semibold ${theme === "dark" ? "text-green-400" : "text-green-700"}`}
                  >
                    📈 Most Improved:{" "}
                  </span>
                  <span
                    className={`text-xs ${theme === "dark" ? "text-gray-300" : "text-gray-700"}`}
                  >
                    {aiInsights.mostImproved}
                  </span>
                </div>
              )}

              {aiInsights.expertAreas &&
                typeof aiInsights.expertAreas === "object" && (
                  <div className="mb-2">
                    <span
                      className={`text-xs font-semibold ${theme === "dark" ? "text-white" : "text-gray-900"}`}
                    >
                      💡 Expert Areas:
                    </span>
                    <ul
                      className={`text-xs mt-1 space-y-1 ${theme === "dark" ? "text-gray-300" : "text-gray-700"}`}
                    >
                      {Object.entries(aiInsights.expertAreas).map(
                        ([name, area], idx) => (
                          <li key={idx}>
                            <span className="font-semibold">{name}:</span>{" "}
                            {area}
                          </li>
                        ),
                      )}
                    </ul>
                  </div>
                )}

              {Array.isArray(aiInsights.recommendations) &&
                aiInsights.recommendations.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-white/10">
                    <span
                      className={`text-xs font-semibold ${theme === "dark" ? "text-white" : "text-gray-900"}`}
                    >
                      📋 Recommendations:
                    </span>
                    <ul
                      className={`text-xs mt-1 list-disc list-inside space-y-1 ${theme === "dark" ? "text-gray-300" : "text-gray-700"}`}
                    >
                      {aiInsights.recommendations.map((tip, idx) => (
                        <li key={idx}>{tip}</li>
                      ))}
                    </ul>
                  </div>
                )}
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default AdminProductivityLeaderboard;
