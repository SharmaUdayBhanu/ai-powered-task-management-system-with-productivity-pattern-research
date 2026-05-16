# File Functionality Map

This document explains where AI prompts are created/sent and where productivity
insight numbers such as score, delta, completion rate, and averages are computed.

## AI Prompt Flow

| File | Responsibility | How It Works |
| --- | --- | --- |
| `server/api/gemini/geminiPrompts.js` | Central prompt builder file | Defines reusable prompt-building functions. These functions return full text prompts for priority detection, task explanation, group task explanation, admin leaderboard insights, daily reports, employee productivity insights, and admin competitive insights. |
| `server/api/gemini/geminiClient.js` | Sends prompts to the AI provider | Exports `callGemini(prompt, options)`. Despite the Gemini naming, this file uses the Groq SDK. It compacts the prompt, applies local rate limiting, prevents duplicate in-flight requests with lock keys, retries rate-limited/server-error calls, sends the prompt as a user message, and returns the model text. It also exports `safeParseJson()` to extract JSON from AI responses. |
| `server/api/gemini/geminiRoutes.js` | API routes for direct AI features | Handles `/api/gemini/priority`, `/api/gemini/explain-task`, `/api/gemini/task-assistant`, and monitoring. It chooses the correct prompt builder, calls `callGemini()`, parses JSON, normalizes results, persists task explanations, and falls back to system-generated guidance when AI is unavailable. |
| `server/api/productivityRoutes.js` | Productivity insights prompt orchestration | Builds structured analytics inputs, passes them into `buildEmployeeInsightsPrompt()` and `buildAdminCompetitiveInsightsPrompt()`, calls `callGemini()`, normalizes AI output, caches insights, and falls back to data-driven insight generation if AI is skipped, invalid, or rate-limited. |
| `server/server.js` | Task creation priority/estimate enrichment | When a single or group task is created, it first assigns a dynamic system priority, then runs background AI refinement using `buildPriorityPrompt()` and `callGemini()`. The final `aiPriority`, `aiPriorityReason`, and sometimes `estimatedDuration` are stored on the task. |
| `client/src/components/other/CreateTask.jsx` | Starts task creation from admin UI | Sends new task data to `/api/employees/:email/tasks` for single tasks or `/api/group-tasks` for group tasks. It does not directly call the AI prompt route; backend enrichment handles priority and estimate. |
| `client/src/components/TaskList/TaskList.jsx` | Requests task explanation from task cards | When a user asks for task guidance, it posts task details to `/api/gemini/explain-task`. If an explanation already exists on the task, it uses the cached one instead. |
| `client/src/components/TaskList/AcceptTask.jsx` | Loads accepted-task guidance | Can call `/api/gemini/explain-task` with task title, description, category, complexity, and estimated duration. It displays returned summary, steps, estimated time, source, and checklist state. |
| `client/src/components/ExplainTaskModal.jsx` | Shows explanation output | Renders the task explanation modal and can update subtask/checklist completion state. It displays AI/system source via `DataSourceBadge`. |
| `client/src/components/TaskChat/TaskChatDock.jsx` | Builds chat assistant request payload | Builds `promptPayload` containing the user question, requester identity, privacy rules, current task context, assigned steps, members, and conversation history. It posts this to `/api/gemini/task-assistant`. |

## Prompt Builders

| Function | File | Used For |
| --- | --- | --- |
| `buildPriorityPrompt()` | `server/api/gemini/geminiPrompts.js` | Determines task priority (`High`, `Medium`, `Low`), reason, and estimated duration from title, description, category, complexity, workload, and deadline. |
| `buildExplainTaskPrompt()` | `server/api/gemini/geminiPrompts.js` | Explains a single employee task with summary, practical steps, and estimated time. |
| `buildGroupExplainTaskPrompt()` | `server/api/gemini/geminiPrompts.js` | Explains a group task and asks AI to assign steps to exact employee names. |
| `buildEmployeeInsightsPrompt()` | `server/api/gemini/geminiPrompts.js` | Creates employee-level productivity insights from structured metrics, recent activity, completion samples, and peer baseline. |
| `buildAdminCompetitiveInsightsPrompt()` | `server/api/gemini/geminiPrompts.js` | Creates admin/team insights from leaderboard snapshot and dashboard summary. |
| `buildRuleBasedTaskGuidance()` | `server/api/gemini/geminiPrompts.js` | System fallback when AI explanation is unavailable. |

## Productivity Formula Files

| File | Responsibility | How It Works |
| --- | --- | --- |
| `server/api/productivityRoutes.js` | Main productivity calculation engine | Computes employee stats, leaderboard rankings, chart data, AI insight inputs, fallback insights, and team baseline metrics. |
| `client/src/components/ProductivityDashboard.jsx` | Employee productivity display | Fetches stats, chart data, and insights. Displays performance score, weekly delta text, average completion, on-time rate, peak window, charts, AI/system insight pills, pattern, specialization, and risk signals. |
| `client/src/components/Dashboard/AdminProductivityLeaderboard.jsx` | Admin leaderboard display | Shows ranking sorted by productivity score and explicitly labels the formula as `score = (completed x 2) - failed`. |
| `client/src/components/Dashboard/EmployeeDashboard.jsx` | Employee dashboard summary delta | Computes a UI-level weekly comparison from current-week completions versus previous-week completions, including percentage change. |
| `server/models.js` | Stores task and analytics fields | Defines task fields such as `aiPriority`, `estimatedDuration`, `completionTime`, `explainSummary`, `explainSteps`, and employee cached analytics such as `storedInsights`, `storedInsightAnalysis`, and `storedChartData`. |

## Core Productivity Formulas

These formulas are implemented mainly in `server/api/productivityRoutes.js`.

### Visible Tasks

Most analytics use only visible tasks:

```text
visible task = task exists AND task.isDeleted is false AND task.notAccepted is false
```

### Productivity Score

Computed in `computeTaskFormulaMetrics()`:

```text
productivityScore = completedTasks * 2 - failedTasks
```

Example:

```text
10 completed tasks and 3 failed tasks
score = (10 * 2) - 3 = 17
```

This score is used for employee stats and admin leaderboard sorting.

### Completion Rate

Computed in `computeTaskFormulaMetrics()`:

```text
completionRate = totalTasks > 0
  ? completedTasks / totalTasks * 100
  : 0
```

The result is rounded to 1 decimal place.

### Average Completion Time

Computed in `computeTaskFormulaMetrics()` using completed tasks:

```text
averageCompletionTimeMinutes = completedTasks.length > 0
  ? sum(completion time minutes for completed tasks) / completedTasks.length
  : 0
```

Completion time is resolved in this priority order:

```text
1. task.completionTime, if already stored
2. completedAt - startedAt
3. completedAt - acceptedAt
4. completedAt - assignedAt
5. task.estimatedDuration
6. null if none can be derived
```

The average is rounded to 1 decimal place.

### On-Time Percent

Computed in `computeStats()`:

```text
onTimePercent = timedCompletedTasks > 0
  ? onTimeCount / timedCompletedTasks * 100
  : 0
```

Where:

```text
timedCompletedTasks = onTimeCount + delayedCount
```

A task is on time when `completedAt <= task deadline`. Date-only deadlines are
treated as end-of-day.

### Delayed Percent

Computed in `computeStats()`:

```text
delayedPercent = timedCompletedTasks > 0
  ? delayedCount / timedCompletedTasks * 100
  : 0
```

The result is rounded to 1 decimal place.

### Productivity Trend Delta

Computed in `computeStats()`:

```text
last7 = completed tasks from the last 7 days
prev7 = completed tasks from the previous 7-day window
productivityTrendDelta = last7 - prev7
```

Example:

```text
last7 = 8
prev7 = 5
delta = 8 - 5 = +3
```

This means the employee completed 3 more tasks in the recent 7-day period than
in the prior 7-day period.

### Trend Label

Computed in `classifyTrend()`:

```text
If very low outcome volume:
  Stable, low confidence

If delta >= 2:
  Improving

If delta > 0 AND completionRate >= 65 AND failurePressure <= 0.4:
  Improving

If delta <= -2:
  Declining

If completionRate < 45:
  Declining

If failurePressure >= 0.6:
  Declining

Otherwise:
  Stable
```

Where:

```text
failurePressure = failed / (completed + failed)
```

### Peak Productivity Window

Computed in `computeStats()`:

```text
1. Group completed tasks by completedAt hour.
2. Find the hour with the highest completion count.
3. Return that 1-hour window, for example `14:00 - 15:00`.
4. Return `N/A` if no completed timestamp exists.
```

### Tasks Per Day Chart

Computed in `computeStats()` and returned by `/api/productivity/:employeeId/chart-data`:

```text
1. Build a dense 14-day date window.
2. Initialize every date count to 0.
3. Count completed tasks by completedAt date inside that window.
```

### Employee Dashboard Percentage Delta

Computed in `client/src/components/Dashboard/EmployeeDashboard.jsx`:

```text
delta = currentWeekCompleted - previousWeekCompleted

percent = previousWeekCompleted > 0
  ? round(delta / previousWeekCompleted * 100)
  : currentWeekCompleted > 0
    ? 100
    : 0
```

This is separate from backend `productivityTrendDelta`, but it uses the same
idea of current period minus previous period.

## Employee Insight Input

Built in `buildEmployeeInsightsInput()` inside `server/api/productivityRoutes.js`.

The AI receives structured JSON containing:

- employee id, name, and email
- total tasks
- completed tasks
- failed tasks
- completion rate
- productivity score
- average completion time
- on-time percent
- delayed percent
- completed last 7 days
- completed previous 7 days
- productivity trend delta
- peak productivity window
- active/new/completed/failed task counts
- recent activity
- completion-time samples
- team baseline comparison
- optional recent action context

This structured input is passed to `buildEmployeeInsightsPrompt()`, then sent
through `callGemini()`.

## Team Baseline Formulas

Computed in `computeTeamBaselineSnapshot()`:

```text
peers = all employees except current employee

avgOnTimePercent = sum(peer.onTimePercent) / peerCount
avgCompletionMinutes = sum(peer.averageCompletionTimeMinutes) / peerCount
avgCompletedLast7 = sum(peer.completedLast7Days) / peerCount
avgProductivityScore = sum(peer.productivityScore) / peerCount
```

Each average is rounded to 1 decimal place.

## Admin Leaderboard And Insights

Admin rankings are built in `/api/productivity/rankings` inside
`server/api/productivityRoutes.js`.

Flow:

```text
1. Load employees.
2. Normalize task timeouts.
3. Compute each employee's stats with computeStats().
4. Set productivityScore from stats.productivityScore.
5. Sort employees descending by productivityScore.
6. Build dashboard summary and leaderboard snapshot.
7. If AI is enabled, build admin prompt and call AI.
8. If AI fails or is disabled, generate data-driven fallback insights.
```

The admin AI prompt receives:

- dashboard summary
- employee count
- top leaderboard snapshot
- productivity score
- completed last 7 days
- trend delta
- on-time percent
- average completion time
- active task count
- new task count

## Priority Formula And AI Refinement

Initial priority is calculated in `server/server.js` before AI completes. The
task is saved quickly with dynamic system priority, then background AI refinement
updates the task later.

There is also a simpler fallback utility in `server/utils/priorityUtils.js`.
That utility scores urgency keywords, description length, task complexity,
estimated duration, and active workload:

```text
urgent keywords add 3 each
medium keywords add 2 each
description length adds 1 to 3
complexity adds its numeric value
estimated duration can add 1 to 3
active workload >= 5 subtracts 2
active workload == 0 adds 1

score >= 7 => High
score <= 3 => Low
otherwise => Medium
```

## Data Storage

Important persisted fields are defined in `server/models.js`.

Task-level AI fields:

- `aiPriority`
- `aiPriorityReason`
- `aiEstimationPending`
- `estimatedDuration`
- `completionTime`
- `explainSummary`
- `explainSteps`
- `explainStepChecks`
- `explainEstimatedTime`
- `explainSource`

Employee-level cached analytics:

- `storedInsights`
- `storedInsightAnalysis`
- `storedChartData`
- `lastInsightUpdate`
- `lastChartUpdate`

