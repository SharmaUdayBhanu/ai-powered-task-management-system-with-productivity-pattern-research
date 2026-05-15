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
- currentNewTasksForEmployee: ${metadata?.newTasks ?? "n/a"}
- deadline: ${metadata?.deadline || "n/a"}

IMPORTANT: Understand CONTEXT and INTENT, not just keywords:
- "revert me now its very imp" = HIGH priority (urgency + importance)
- "ASAP", "urgent", "critical", "immediately", "need it now" = HIGH
- "when you get a chance", "low priority", "can wait" = LOW
- Tasks with deadlines or time-sensitive outcomes = HIGH
- Complex tasks requiring immediate attention = HIGH
- Simple, non-urgent tasks = MEDIUM or LOW
- Balance urgency against workload: deadlines and blockers raise priority; heavy workload without near-term deadline may lower priority to protect flow
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
  "estimated_time": "human-readable time estimate, e.g. '30-45 minutes including testing'"
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

export function buildGroupExplainTaskPrompt({
  title,
  description,
  metadata,
  members = [],
}) {
  const membersText = members
    .map((member, idx) => {
      const summary = String(member.summary || "").trim();
      const summaryText = summary ? ` - recent: ${summary}` : "";
      return `${idx + 1}. ${member.name} (${member.role || "employee"})${summaryText}`;
    })
    .join("\n");

  return `
You are coordinating a GROUP task across multiple employees.

Return a **compact JSON object** ONLY, no additional text, in the exact format:
{
  "summary": "2-3 complete sentences explaining the task in plain, encouraging language with context and expected outcome.",
  "steps": [
    { "text": "specific step", "assigned_to": "Employee Name" },
    { "text": "specific step", "assigned_to": "Employee Name" }
  ],
  "estimated_time": "human-readable time estimate, e.g. '30-45 minutes including testing'"
}

CRITICAL REQUIREMENTS:
- Each step MUST include an assigned_to value.
- assigned_to MUST match one of the employee names EXACTLY as provided below.
- Distribute work across ALL employees; ensure each employee gets at least one step if possible.
- Keep steps concise, actionable, and non-overlapping.
- The summary must be 2-3 complete sentences, not cut off.

Task title: ${title || ""}
Task description: ${description || ""}
Metadata (may be partial):
- category: ${metadata?.category || "n/a"}
- complexity: ${metadata?.complexity ?? "n/a"}
- estimatedDurationMinutes: ${metadata?.estimatedDuration ?? "n/a"}

Employees:
${membersText || "No employees provided"}
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
      : "30-60 minutes";

  const summary = safeDescription
    ? `Focus on ${safeTitle} in the ${category} category. Keep scope clear, execute step-by-step, and confirm the expected output before marking progress complete.`
    : `Focus on ${safeTitle} in the ${category} category. Define a clear output, execute in small steps, and validate completion before closing.`;

  const steps = [
    `Clarify the expected outcome for "${safeTitle}" and list the key acceptance points before starting.`,
    "Break the work into 2-4 small checkpoints and complete the highest-impact checkpoint first.",
    "Update progress after each checkpoint and resolve blockers immediately to avoid delay accumulation.",
    "Do a final quality pass against the task description and submit a concise completion update.",
  ];

  return {
    summary,
    steps,
    estimated_time: durationText,
    source: "System",
    fromFallback: true,
  };
}

export function buildEmployeeInsightsPrompt({ input }) {
  return `
You are an analytics assistant.
You must analyze ONLY the JSON input provided below. Every headline must be unique and specific to this employee (use their name or concrete counts from the input). Do not reuse generic coaching phrases.

Rules:
- Use only values present in the JSON input (names, counts, percentages, task titles from recentActivity, peer averages from teamBaseline).
- Do not invent numbers, dates, or tasks.
- quickActions are forward-looking moves the employee or manager can take this week.
- riskSignals are downside scenarios or warning signs grounded in the metrics (different wording and intent than quickActions; no copy-paste between the two lists).
- Each rationale must cite at least two concrete facts from the input (numbers, task statuses, peer deltas, or recent task titles).
- Headlines must be under 12 words and must not repeat across quickActions and riskSignals.

Return ONLY valid JSON in this exact format:
{
  "quickActions": [
    { "headline": "unique short label", "rationale": "why this action fits, citing specific input facts" }
  ],
  "riskSignals": [
    { "headline": "unique short risk label", "rationale": "why this risk matters, citing specific input facts" }
  ],
  "workloadOutlook": {
    "headline": "short workload posture label",
    "rationale": "ground in active/new task counts and recent completion cadence from input"
  },
  "pattern": "one-line behavior pattern tied to their metrics",
  "specialization": "what work this employee is best suited for based on input",
  "consistency": "high|moderate|low — short evidence from input",
  "changeDetection": {
    "status": "improving|declining|stable",
    "reason": "short reason comparing recent vs previous window using input numbers"
  },
  "comparativeSignal": "how this employee differs from peer baseline using only teamBaseline figures"
}

Sizes: 3-4 quickActions, 2-3 riskSignals.

Input JSON:
${JSON.stringify(input)}
  `.trim();
}

export function buildAdminCompetitiveInsightsPrompt({ input }) {
  return `
You are an analytics assistant for an admin dashboard.
Analyze ONLY the structured JSON input to identify performance patterns, trends, and issues.

Rules:
- Use only values present in the input (leaderboardSnapshot names, scores, on-time %, trend deltas, completion counts, active/new task counts).
- No invented numbers or employees.
- recommendations must be manager actions; each must cite at least two leaderboard facts.
- teamDiagnostics explain team state (cadence, workload, failures, momentum) and must not reuse recommendation wording.
- Avoid generic labels like "top performer" without naming the person and citing their metrics.

Return ONLY valid JSON in this exact format:
{
  "summary": "2-3 concise sentences naming people when you cite performance or workload",
  "topPerformer": "one sentence naming the leader and citing score + on-time or completion signal from input",
  "mostImproved": "one sentence naming the employee and citing trend delta / last-7-days completions from input",
  "needsAttention": "one sentence naming the employee who most needs support right now, citing score, failures, or last-7-days completions from input (must not duplicate mostImproved)",
  "teamDiagnostics": [
    { "headline": "Team cadence", "rationale": "ground in aggregate completion rate and productivity score from input" },
    { "headline": "Workload balance", "rationale": "compare employees' last-7-days completions and scores from leaderboardSnapshot" },
    { "headline": "Failure / risk concentration", "rationale": "cite failed vs completed patterns visible in input" },
    { "headline": "Momentum shifts", "rationale": "cite trend deltas from leaderboardSnapshot" }
  ],
  "underutilizedEmployees": ["specific notes naming employees with low last-7-days completions from input"],
  "employeeInsights": [
    {
      "name": "employee name",
      "email": "employee email if available",
      "pattern": "short behavior pattern from their stats",
      "specialization": "best-fit work type from their stats",
      "riskSignal": "main risk to monitor with a metric",
      "changeSignal": "improving|declining|stable with brief reason from trend delta"
    }
  ],
  "expertAreas": {
    "employeeName": "what they are best at (cite a metric)"
  },
  "recommendations": [
    { "headline": "short action label", "rationale": "why and who based on leaderboardSnapshot" }
  ]
}

Input JSON:
${JSON.stringify(input)}
  `.trim();
}
