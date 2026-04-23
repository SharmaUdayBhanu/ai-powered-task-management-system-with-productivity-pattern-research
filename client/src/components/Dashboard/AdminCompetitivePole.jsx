import React, { useEffect, useState } from "react";
import axios from "axios";
import { io } from "socket.io-client";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";

const API_URL = `${import.meta.env.VITE_API_URL || ""}/api`;

const AdminCompetitivePole = ({ employees, theme = "dark" }) => {
  const [leaderboardData, setLeaderboardData] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchRankings = async () => {
      setLoading(true);
      try {
        const res = await axios.get(`${API_URL}/productivity/rankings`);
        setLeaderboardData(res.data.leaderboard || []);
      } catch (err) {
        console.warn("Failed to load rankings:", err);
      } finally {
        setLoading(false);
      }
    };
    fetchRankings();

    // Real-time updates
    const socket = io(import.meta.env.VITE_API_URL || window.location.origin, {
      transports: ["websocket"],
    });
    socket.on("taskStatusChanged", () => {
      fetchRankings();
    });
    socket.on("taskActionCompleted", () => {
      fetchRankings();
    });

    return () => socket.disconnect();
  }, [employees]);

  if (loading) {
    return (
      <div className={`p-4 rounded-lg ${theme === "dark" ? "bg-gray-800" : "bg-gray-50"}`}>
        <div className={`text-sm ${theme === "dark" ? "text-gray-400" : "text-gray-600"}`}>Loading competitive analysis...</div>
      </div>
    );
  }

  if (leaderboardData.length === 0) {
    return (
      <div className={`p-4 rounded-lg ${theme === "dark" ? "bg-gray-800" : "bg-gray-50"}`}>
        <div className={`text-sm ${theme === "dark" ? "text-gray-400" : "text-gray-600"}`}>No employee data available</div>
      </div>
    );
  }

  // Prepare data for competitive pole chart
  const chartData = leaderboardData.map((entry, idx) => ({
    name: entry.name,
    rank: idx + 1,
    productivityScore: entry.productivityScore,
    onTimeRate: entry.stats.onTimePercent,
    avgCompletion: entry.stats.averageCompletionTimeMinutes,
    completedLast7: entry.stats.completedLast7Days,
    trend: entry.stats.productivityTrendDelta,
  }));

  const maxScore = Math.max(...chartData.map(d => d.productivityScore), 100);

  return (
    <div className={`p-6 rounded-lg border ${theme === "dark" ? "bg-gray-800 border-gray-700" : "bg-white border-gray-200"}`}>
      <h2 className={`text-xl font-semibold mb-4 ${theme === "dark" ? "text-white" : "text-gray-900"}`}>
        Competitive Productivity Pole
      </h2>
      
      <div className="mb-6">
        <ResponsiveContainer width="100%" height={400}>
          <BarChart data={chartData} layout="vertical">
            <CartesianGrid strokeDasharray="3 3" stroke={theme === "dark" ? "#444" : "#ddd"} />
            <XAxis type="number" domain={[0, maxScore]} stroke={theme === "dark" ? "#999" : "#666"} />
            <YAxis dataKey="name" type="category" width={100} stroke={theme === "dark" ? "#999" : "#666"} />
            <Tooltip
              contentStyle={{
                backgroundColor: theme === "dark" ? "#1f2937" : "#fff",
                border: theme === "dark" ? "1px solid #374151" : "1px solid #e5e7eb",
                color: theme === "dark" ? "#fff" : "#000",
              }}
              formatter={(value, name) => {
                if (name === "productivityScore") return [`${value.toFixed(2)}`, "Productivity Score"];
                if (name === "onTimeRate") return [`${value.toFixed(1)}%`, "On-Time Rate"];
                if (name === "avgCompletion") return [`${value} min`, "Avg Completion"];
                if (name === "completedLast7") return [value, "Completed Last 7 Days"];
                return [value, name];
              }}
            />
            <Legend />
            <Bar dataKey="productivityScore" fill="#3b82f6" name="Productivity Score" />
            <Bar dataKey="onTimeRate" fill="#22c55e" name="On-Time Rate %" />
            <Bar dataKey="completedLast7" fill="#f59e0b" name="Completed Last 7 Days" />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-6">
        {chartData.slice(0, 3).map((entry, idx) => (
          <div
            key={entry.name}
            className={`p-4 rounded-lg border ${
              idx === 0
                ? theme === "dark"
                  ? "bg-yellow-900/20 border-yellow-600"
                  : "bg-yellow-50 border-yellow-300"
                : theme === "dark"
                ? "bg-gray-700 border-gray-600"
                : "bg-gray-50 border-gray-200"
            }`}
          >
            <div className="flex items-center gap-2 mb-2">
              <span className={`text-2xl font-bold ${idx === 0 ? "text-yellow-500" : theme === "dark" ? "text-gray-400" : "text-gray-600"}`}>
                #{entry.rank}
              </span>
              <h3 className={`font-semibold ${theme === "dark" ? "text-white" : "text-gray-900"}`}>{entry.name}</h3>
            </div>
            <div className={`text-xs space-y-1 ${theme === "dark" ? "text-gray-300" : "text-gray-700"}`}>
              <div>Score: <span className="font-semibold">{entry.productivityScore.toFixed(2)}</span></div>
              <div>On-Time: <span className="font-semibold">{entry.onTimeRate.toFixed(1)}%</span></div>
              <div>Avg Time: <span className="font-semibold">{entry.avgCompletion} min</span></div>
              <div>Last 7 Days: <span className="font-semibold">{entry.completedLast7} tasks</span></div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default AdminCompetitivePole;

