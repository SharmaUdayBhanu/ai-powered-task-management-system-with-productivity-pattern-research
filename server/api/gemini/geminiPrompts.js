export function buildPriorityPrompt({ title, description, metadata }) {
  return `
You are an AI assistant analyzing task priority in an Employee Task Management system.
Analyze the task title and description to understand the URGENCY and IMPORTANCE, not just keywords.

Return a **compact JSON object** ONLY, no additional text, in the exact format:
{
  "priority": "High" | "Medium" | "Low",
  "reason": "short reason here",
  "estimated_duration_minutes": number
}

Task title: ${title || ""}
Task description: ${description || ""}
Metadata (may be partial):
- category: ${metadata?.category || "n/a"}
- estimatedDurationMinutes: ${metadata?.estimatedDuration ?? "n/a"}
- complexity: ${metadata?.complexity ?? "n/a"}
- currentActiveTasksForEmployee: ${metadata?.activeTasks ?? "n/a"}

IMPORTANT: Understand CONTEXT and INTENT, not just keywords:
- "revert me now its very imp" = HIGH priority (urgency + importance)
- "ASAP", "urgent", "critical", "immediately", "need it now" = HIGH
- "when you get a chance", "low priority", "can wait" = LOW
- Tasks with deadlines or time-sensitive outcomes = HIGH
- Complex tasks requiring immediate attention = HIGH
- Simple, non-urgent tasks = MEDIUM or LOW
- If employee has many active tasks, consider lowering priority to avoid overload
- If estimatedDurationMinutes is missing from metadata, infer realistic effort and return estimated_duration_minutes
- estimated_duration_minutes must be a single number in minutes (for ranges, return the midpoint)

Analyze the MEANING and CONTEXT of the description, not just individual words.
  `.trim();
}

export function buildExplainTaskPrompt({ title, description, metadata }) {
  return `
You are helping an employee understand and execute a task efficiently.

Return a **compact JSON object** ONLY, no additional text, in the exact format:
{
  "summary": "2-3 complete sentences explaining the task in plain, encouraging language with context and expected outcome.",
  "steps": ["at least 3 practical, sequential steps with verbs and specifics", "...", "...", "..."],
  "estimated_time": "human-readable time estimate, e.g. '30–45 minutes including testing'"
}

CRITICAL REQUIREMENTS:
- Each step must be COMPLETE and FULLY WRITTEN - do not truncate or cut off mid-sentence
- Each step should be a complete sentence or phrase describing what to do and why
- Steps should reference any tools, meetings, or deliverables if mentioned in the task
- Ensure ALL steps are included in the response - do not stop early
- The summary must be 2-3 complete sentences, not cut off

Task title: ${title || ""}
Task description: ${description || ""}
Metadata (may be partial):
- category: ${metadata?.category || "n/a"}
- complexity: ${metadata?.complexity ?? "n/a"}
- estimatedDurationMinutes: ${metadata?.estimatedDuration ?? "n/a"}
  `.trim();
}

export function buildAdminLeaderboardPrompt({ leaders }) {
  const serialized = leaders
    .map(
      (leader, idx) =>
        `${idx + 1}. ${leader.name} - avgCompletion ${leader.avgCompletion} min, onTime ${leader.onTimePercent}%, completedLast7 ${leader.completedLast7}, trendDelta ${leader.trendDelta}`,
    )
    .join("\n");

  return `
You are advising an operations manager about employee productivity.
Given the ranked stats below, produce a JSON object with a short summary and 3 recommendations.

Return JSON only:
{
  "summary": "2-3 sentences highlighting top performers and key concerns",
  "recommendations": ["actionable tip 1", "tip 2", "tip 3"]
}

Ranked employees:
${serialized || "No data"}
  `.trim();
}

export function buildDailyReportPrompt({ employeeName, summaryStats }) {
  return `
You generate a short daily productivity reflection for an employee.

Return a **compact JSON object** ONLY, no additional text, in the exact format:
{
  "headline": "one-sentence highlight",
  "wins": ["short bullet 1", "short bullet 2"],
  "focus_next": ["short bullet 1", "short bullet 2"]
}

Employee: ${employeeName}

Recent stats:
- tasksCompletedToday: ${summaryStats?.tasksCompletedToday ?? 0}
- averageCompletionMinutes: ${summaryStats?.averageCompletionMinutes ?? "n/a"}
- onTimeRatePercent: ${summaryStats?.onTimeRatePercent ?? "n/a"}
- peakProductivityWindow: ${summaryStats?.peakProductivityWindow ?? "n/a"}
  `.trim();
}

export function buildRuleBasedTaskGuidance({ title, description, metadata }) {
  const safeTitle = String(title || "this task").trim() || "this task";
  const safeDescription = String(description || "").trim();
  const category = String(metadata?.category || "General").trim() || "General";
  const estimatedDuration = Number(metadata?.estimatedDuration);
  const durationText =
    Number.isFinite(estimatedDuration) && estimatedDuration > 0
      ? `${estimatedDuration} minutes`
      : "30–60 minutes";

  const summary = safeDescription
    ? `Focus on ${safeTitle} in the ${category} category. Keep scope clear, execute step-by-step, and confirm the expected output before marking progress complete.`
    : `Focus on ${safeTitle} in the ${category} category. Define a clear output, execute in small steps, and validate completion before closing.`;

  const steps = [
    `Clarify the expected outcome for "${safeTitle}" and list the key acceptance points before starting.`,
    "Break the work into 2–4 small checkpoints and complete the highest-impact checkpoint first.",
    "Update progress after each checkpoint and resolve blockers immediately to avoid delay accumulation.",
    "Do a final quality pass against the task description and submit a concise completion update.",
  ];

  return {
    summary,
    steps,
    estimated_time: durationText,
    fromFallback: true,
  };
}

export function buildEmployeeInsightsPrompt({ input }) {
  return `
You are an analytics assistant.
You must analyze ONLY the JSON input provided below and generate concise, behavior-oriented insights.

Rules:
- Use only values present in the JSON input.
- Do not invent numbers or events.
- Do not restate raw metric values unless required to explain a pattern.
- Focus on patterns, consistency, risks, specialization, and change signals.
- Keep all fields short, concrete, and non-generic.

Return ONLY valid JSON in this exact format:
{
  "insights": ["3-5 concise pattern insights"],
  "pattern": "one-line behavior pattern",
  "specialization": "what work this employee is best suited for",
  "consistency": "high|moderate|low with short evidence",
  "riskSignals": ["up to 3 short risk signals"],
  "changeDetection": {
    "status": "improving|declining|stable",
    "reason": "short reason based on recent vs previous performance"
  },
  "comparativeSignal": "how this employee differs from peer baseline in the provided data"
}

Input JSON:
${JSON.stringify(input)}
  `.trim();
}

export function buildAdminCompetitiveInsightsPrompt({ input }) {
  return `
You are an analytics assistant for an admin dashboard.
Analyze ONLY the structured JSON input to identify performance patterns, trends, and issues.

Rules:
- Use only values present in the input.
- No invented numbers.
- Keep output concise and structured.
- Avoid generic coaching language.
- Prioritize comparative/team-level reasoning over isolated metric repetition.

Return ONLY valid JSON in this exact format:
{
  "summary": "2-3 concise sentences",
  "topPerformer": "short explanation",
  "mostImproved": "short explanation",
  "teamPattern": "overall operating pattern of the team",
  "workloadImbalance": "where workload appears uneven and why",
  "failureClusters": "where/why failures are clustering",
  "underutilizedEmployees": ["employee or role-level underutilization notes"],
  "changeSignals": ["improving/declining/stable shifts with cause"],
  "employeeInsights": [
    {
      "name": "employee name",
      "email": "employee email if available",
      "pattern": "short behavior pattern",
      "specialization": "best-fit work type",
      "riskSignal": "main risk to monitor",
      "changeSignal": "improving|declining|stable with brief reason"
    }
  ],
  "expertAreas": {
    "employeeName": "what they are best at"
  },
  "recommendations": ["tip 1", "tip 2", "tip 3"]
}

Input JSON:
${JSON.stringify(input)}
  `.trim();
}
