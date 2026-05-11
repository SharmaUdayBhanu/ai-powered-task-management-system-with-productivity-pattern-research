# AI-Driven Task Management System With Productivity Pattern Research

## Purpose of this document

This file explains the complete project in presentation-friendly language. It describes what the application does, what each important file is responsible for, how the major functions work, what data the system already collects, and how this project can be extended into a research-backed machine learning system.

Use this document for:

- Preparing a project presentation.
- Explaining the project architecture to teachers, reviewers, or teammates.
- Finding a relevant dataset for productivity and task-management research.
- Planning a machine learning model based on task behavior, completion time, priority, workload, and productivity patterns.
- Writing a research paper that connects the software project with productivity analytics and AI-assisted task management.

## Project summary

The project is a full-stack task management and employee productivity analysis system. It allows an admin to create employees, assign tasks, monitor task progress, compare employee productivity, and view AI-assisted insights. Employees can log in, accept tasks, complete or fail tasks, view task priority, see deadline timers, and request AI-generated guidance for task execution.

The main research idea is:

> An AI-driven task management system can improve productivity by analyzing task priority, deadline pressure, workload, completion behavior, and employee performance patterns, then using those insights to recommend better task planning and management strategies.

The current implementation already supports many research-relevant signals, including:

- Task status: new, active, completed, failed, not accepted.
- Task priority: High, Medium, Low.
- Estimated task duration.
- Actual completion time.
- Deadline/on-time status.
- Acceptance time limits.
- Weekly productivity trends.
- Completion rate.
- Average completion time.
- Productivity score.
- Peak productivity window.
- Admin leaderboard.
- Employee-level and team-level AI insights.

## Main application roles

### Admin

The admin is responsible for managing the team and tasks.

Admin functions include:

- Login as admin.
- Add employees.
- Assign tasks to employees.
- Set task title, description, date, category, estimated duration, and acceptance time limit.
- View all employees.
- View team productivity summary.
- View employee cards with productivity signals.
- Compare employees using leaderboard rankings.
- View AI or rule-based recommendations about team performance.
- Identify top performers and employees needing attention.

### Employee

The employee is responsible for handling assigned tasks.

Employee functions include:

- Login after account activation.
- Set password during first login.
- View assigned tasks.
- Accept new tasks before the acceptance deadline.
- Mark active tasks as completed or failed.
- View AI-suggested task priority.
- View deadline timer.
- View productivity dashboard.
- View charts and insights about personal productivity.
- Open AI task explanation/checklist for active tasks.

## Technology stack

### Frontend

- React 18 for UI.
- Vite for development and build.
- Tailwind CSS for styling.
- Axios and Fetch for API calls.
- Socket.IO client for real-time updates.
- Recharts for productivity visualizations.
- Lucide React for icons.

### Backend

- Node.js.
- Express.js.
- MongoDB with Mongoose.
- Socket.IO for real-time events.
- Groq SDK used as the AI provider client.
- Environment variables for API keys and database connection.

### Deployment support

- `api/index.js` adapts the Express app to Vercel serverless functions.
- `vercel.json` configures frontend/backend routing for Vercel.
- Health endpoints help debug deployment and MongoDB connection issues.

## High-level architecture

The app has three main parts:

1. `client/`

   The React frontend. It contains login screens, admin dashboard, employee dashboard, task cards, productivity charts, and AI insight UI.

2. `server/`

   The Express backend. It handles authentication, employee creation, task assignment, task updates, AI priority/explanation generation, productivity analytics, MongoDB models, and real-time Socket.IO events.

3. `api/`

   The Vercel serverless entry point. It imports the Express backend and makes it work as a Vercel API handler.

## Data model

The main database file is `server/models.js`.

### Task data

Each employee has an array of tasks. Each task can store:

- `taskTitle`: title of the task.
- `taskDescription`: detailed task description.
- `taskDate`: deadline/date.
- `category`: task category.
- `newTask`: true when assigned but not accepted.
- `active`: true after employee accepts the task.
- `completed`: true after successful completion.
- `failed`: true after failure or timeout.
- `notAccepted`: true when the employee did not accept before deadline.
- `aiPriority`: AI or fallback priority value: High, Medium, Low.
- `aiPriorityReason`: reason behind priority.
- `aiEstimationPending`: whether AI duration/priority calculation is still pending.
- `assignedAt`, `createdAt`, `acceptedAt`, `startedAt`, `completedAt`: timestamps for behavior tracking.
- `estimatedDuration`: expected duration in minutes.
- `completionTime`: actual/derived completion time in minutes.
- `acceptanceTimeLimitMinutes`: time allowed to accept a task.
- `acceptanceDeadline`: computed deadline for accepting the task.
- `complexity`, `effortLevel`, `cognitiveLoadScore`: research-friendly fields for future ML use.
- `onTime`: whether completion happened before deadline.
- `insights`: task-level analysis text.
- `explainSummary`, `explainSteps`, `explainEstimatedTime`: cached AI task guidance.
- `isDeleted`, `deletedAt`: soft-delete support so hidden tasks can still remain in analytics.

### Employee data

Each employee stores:

- `firstName`, `lastName`, `email`.
- `password`.
- `role`.
- `isFirstLogin`, `isPasswordSet`, `isActivated`.
- `taskCounts`: current counts of active, new, completed, and failed tasks.
- `tasks`: embedded task records.
- `storedInsights`: cached productivity insights.
- `storedChartData`: cached chart data.
- `lastInsightUpdate`, `lastChartUpdate`: cache timestamps.

### Admin data

Admin stores:

- `email`.
- `password`.

## Important backend files

### `server/server.js`

This is the main backend application file.

Responsibilities:

- Creates the Express app.
- Connects to MongoDB.
- Sets up Socket.IO for real-time updates in local Node runtime.
- Adds CORS and JSON parsing middleware.
- Defines core REST API routes.
- Mounts AI routes at `/api/gemini`.
- Mounts productivity routes at `/api/productivity`.
- Starts the server when run directly.

Important helper functions:

- `redactMongoUri(uri)`: hides password from MongoDB URI in logs.
- `serializeError(err)`: converts errors into safe structured log objects.
- `toTaskDeadline(taskDateValue)`: converts task date to a deadline, treating date-only values as end-of-day.
- `computeOnTime(completedAt, taskDateValue)`: checks whether a task was completed before its deadline.
- `buildTaskIdentityKey(task)`: creates a fallback identity key for matching tasks.
- `resolveTaskStartTime(task)`: finds the best available task start time.
- `resolveCompletionTimeMinutes(task, completedAt)`: calculates completion duration from timestamps or existing values.
- `computeTaskCounts(tasks)`: counts visible active, new, completed, and failed tasks.
- `parseDurationStringToMinutes(value)`: extracts duration from strings like `2 hours`, `45 min`, or `1-2 hours`.
- `normalizeEstimatedDurationMinutes(rawValue, fallbackMinutes)`: converts estimated duration into a bounded minute value.
- `computeFallbackEstimatedDurationMinutes(task)`: estimates task duration using complexity, description length, and category.
- `normalizePriorityValue(value)`: keeps priority within High, Medium, or Low.
- `enrichTaskAiMetadataInBackground(...)`: calls AI after task creation to update priority and estimated duration.
- `applyTaskTimeouts(employeeOrUpdate)`: marks tasks as not accepted or failed if deadlines expire.
- `generateAndCacheTaskGuidance(...)`: generates and stores AI task guidance.
- `connectDB()`: connects to MongoDB with timeout and logging support.
- `startServer()`: starts the Node server locally.

Important routes:

- `GET /api/health`: basic server and environment health check.
- `GET /api/health/db`: verifies database connection.
- `POST /api/employees`: creates a new employee account.
- `POST /api/auth/login`: logs in admin or employee.
- `POST /api/auth/set-password`: lets first-time employee set password.
- `POST /api/auth/signup`: activates an admin-created employee account.
- `GET /api/employees`: returns all employees.
- `GET /api/employees/:email`: returns one employee and normalizes expired task states.
- `PUT /api/employees/:email`: updates employee/task data and emits real-time events.
- `POST /api/employees/:email/tasks`: adds a new task to an employee and starts background AI enrichment.
- `POST /api/admin/login`: legacy/simple admin login endpoint.

Real-time events emitted:

- `employeeUpdated`: employee data changed.
- `taskCreated`: new task assigned.
- `taskAiUpdated`: AI priority/duration updated.
- `taskExplanationGenerated`: AI explanation generated.
- `taskStatusChanged`: task status changed.
- `taskActionCompleted`: task completed or failed, useful for insight refresh.

### `server/models.js`

Defines the MongoDB schemas and exports Mongoose models.

Responsibilities:

- Defines `taskSchema`.
- Defines `employeeSchema`.
- Defines `adminSchema`.
- Exports `Employee` model.
- Exports `Admin` model.

This file is extremely important for research because it shows what variables the system can already collect for a dataset.

### `server/api/productivityRoutes.js`

This file handles productivity analytics and insights.

Responsibilities:

- Computes employee productivity stats.
- Builds chart data.
- Builds admin leaderboard.
- Generates employee and admin insights using AI when available.
- Uses rule-based fallback when AI is unavailable.
- Caches insights to reduce repeated AI calls.
- Handles low-data situations carefully.
- Normalizes expired tasks before analytics.

Important helper functions:

- `isVisibleTask(task)`: filters out deleted and not-accepted tasks.
- `getVisibleTasks(tasks)`: returns tasks usable for most dashboard analytics.
- `classifyTrend(...)`: labels productivity as Improving, Stable, or Declining.
- `buildConsistencyReport(...)`: checks whether leaderboard totals match dashboard totals.
- `isFresh(dateValue, ttlMs)`: checks if cached insights are still valid.
- `toDayKey(date)`, `parseDayKey(dayKey)`, `formatDayLabel(date)`: date formatting helpers.
- `getWindowStart(days)`: gets start date for chart window.
- `getTaskDeadline(taskDate)`: resolves task deadline.
- `resolveOnTime(task)`: determines on-time status.
- `resolveCompletionTimeMinutes(task)`: calculates completion duration.
- `computeTaskFormulaMetrics(tasks)`: calculates total tasks, completion rate, productivity score, and average completion time.
- `buildRecentActivity(tasks)`: summarizes recent task activity.
- `buildCompletionTimeSamples(tasks)`: creates examples for completion-time analysis.
- `normalizeEmployeeAiAnalysis(raw)`: cleans AI response for employee insights.
- `normalizeAdminInsights(raw)`: cleans AI response for admin insights.
- `buildEmployeeInsightsInput(...)`: creates structured input for AI analysis.
- `computeTeamBaselineSnapshot(...)`: compares one employee against peers.
- `generateDataDrivenInsights(input)`: creates rule-based productivity insights.
- `mergeWithAuthoritativeInsights(...)`: combines AI insights with guaranteed metric-based insights.
- `buildEmployeePatternFallback(input)`: creates fallback employee pattern analysis.
- `buildLowDataEmployeeAnalysis(input)`: avoids overclaiming when not enough data exists.
- `generateAdminDataDrivenInsights(...)`: creates fallback admin/team analysis.
- `reconcileAdminInsights(...)`: combines AI admin output with metric-backed output.
- `computeStats(employee)`: main productivity statistics function.

Important routes:

- `GET /api/productivity/monitoring`: shows AI/cache telemetry for productivity system.
- `GET /api/productivity/rankings`: returns leaderboard, team summary, and admin insights.
- `GET /api/productivity/:employeeId/stats`: returns employee metrics.
- `GET /api/productivity/:employeeId/chart-data`: returns chart data for tasks per day and completion time.
- `GET /api/productivity/:employeeId/insights`: returns employee insights and productivity analysis.

Important productivity formulas:

- Completion rate:

  `completedTasks / totalTasks * 100`

- Productivity score:

  `completedTasks * 2 - failedTasks`

- Average completion time:

  `sum(completionTimeMinutes) / completedTasks`

- Weekly trend:

  `completedLast7Days - completedPrevious7Days`

- Trend label:

  Uses completion volume, failure pressure, and completion rate to classify as Improving, Stable, or Declining.

### `server/api/gemini/geminiClient.js`

This is the AI provider utility layer.

Responsibilities:

- Reads Groq API key from environment.
- Chooses the model.
- Sends prompts to the AI model.
- Applies rate limiting.
- Applies timeout handling.
- Prevents duplicate in-flight requests using lock keys.
- Tracks AI telemetry.
- Parses JSON safely from AI responses.
- Records fallback counts when AI is unavailable.

Important functions:

- `hasAiClientConfig()`: checks whether AI API key exists.
- `recordAiFallback(context)`: increments fallback telemetry.
- `getAiTelemetrySnapshot()`: returns AI usage/failure stats.
- `getRetryAfterMs(err)`: calculates retry delay after rate limiting.
- `isGeminiRateLimited(err)`: detects AI rate-limit errors.
- `callGemini(prompt, options)`: main function for AI calls.
- `safeParseJson(text, fallback)`: extracts and parses JSON from AI response.

Note: The file names mention Gemini, but the implementation uses the Groq SDK and a Groq-hosted model by default. In presentation, describe it as an AI/LLM integration layer unless you specifically configure Gemini elsewhere.

### `server/api/gemini/geminiPrompts.js`

This file contains prompt builders.

Responsibilities:

- Builds AI prompt for task priority.
- Builds AI prompt for task explanation.
- Builds AI prompt for employee productivity insights.
- Builds AI prompt for admin competitive/team insights.
- Provides rule-based fallback task guidance.

Important functions:

- `buildPriorityPrompt(...)`: asks AI to classify task priority and estimate time.
- `buildExplainTaskPrompt(...)`: asks AI to summarize a task and generate steps.
- `buildAdminLeaderboardPrompt(...)`: older/admin leaderboard prompt helper.
- `buildDailyReportPrompt(...)`: daily report prompt helper.
- `buildRuleBasedTaskGuidance(...)`: fallback explanation without AI.
- `buildEmployeeInsightsPrompt(...)`: prompt for employee productivity pattern analysis.
- `buildAdminCompetitiveInsightsPrompt(...)`: prompt for admin team-level recommendations.

### `server/api/gemini/geminiRoutes.js`

This file exposes AI endpoints to the frontend.

Responsibilities:

- Generates AI priority for a task.
- Generates task explanation/checklist.
- Caches explanation on the task.
- Handles AI cooldowns and in-flight duplicate requests.
- Falls back to rule-based guidance when AI is unavailable.

Important routes:

- `GET /api/gemini/monitoring`: AI route telemetry.
- `POST /api/gemini/priority`: returns priority and reason for a task.
- `POST /api/gemini/explain-task`: returns summary, steps, and estimated time for a task.

Important helper functions:

- `getTaskLookupKey(...)`: creates a stable key for explanation caching.
- `getExistingTaskExplanation(task)`: reads cached task explanation.
- `normalizeExplanationPayload(...)`: validates AI explanation output.
- `parseEstimatedMinutes(value)`: converts estimated time text to minutes.
- `persistTaskExplanation(...)`: writes explanation into employee task record.

### `server/utils/priorityUtils.js`

Provides a simple rule-based priority algorithm.

Function:

- `computeRuleBasedPriority(task, employee)`: calculates priority using keywords, description length, complexity, estimated duration, and employee active task count.

This is useful for research because it can act as a baseline model. A future ML model should be compared against this rule-based baseline.

### `server/seeds/seedDemoData.js`

Seeds demo data into MongoDB.

Use this file to populate the app with sample employees, tasks, admins, and productivity history for demonstrations.

### `server/gemini.js`

This appears to be an older or standalone AI-related server file. The active modular AI implementation is mainly inside `server/api/gemini/`.

### `server/payload.json`

Stores sample JSON payload data for testing or debugging.

### `server/.env.example`

Shows the environment variables required for the backend.

Expected variables include:

- `MONGODB_URI`.
- `GROQ_API_KEY`.
- Optional AI tuning variables such as model, max calls, and prompt length.

Do not commit real `.env` secrets.

## Vercel API file

### `api/index.js`

This file adapts the Express backend for Vercel.

Responsibilities:

- Imports `app` and `connectDB` from `server/server.js`.
- Connects to MongoDB before non-health API requests.
- Keeps `/api/health` available even if database connection fails.
- Catches startup errors and returns structured JSON diagnostics.
- Exports Vercel API config.

This is important for deployment because traditional Express servers run continuously, but Vercel functions start on demand.

## Important frontend files

### `client/src/main.jsx`

React entry point.

Responsibilities:

- Mounts the app into the DOM.
- Wraps the app with `AuthProvider`.
- Imports global CSS.

### `client/src/App.jsx`

Top-level frontend application component.

Responsibilities:

- Maintains logged-in user state.
- Restores login session from `localStorage`.
- Handles login through `/api/auth/login`.
- Handles signup/password activation through `/api/auth/signup`.
- Decides whether to show login screen, admin dashboard, employee dashboard, or password setup.

Important functions:

- `parseApiPayload(res)`: parses API response safely.
- `handleLogin(email, password)`: logs in admin/employee.
- `handleSignup(email, newPassword, options)`: activates employee account.

### `client/src/context/AuthProvider.jsx`

Global app data provider.

Responsibilities:

- Fetches employees from backend.
- Stores employee/admin data in React context.
- Listens for Socket.IO events.
- Updates context when employee/task changes happen.

Important events listened to:

- `employeeUpdated`.
- `taskCreated`.
- `taskExplanationGenerated`.
- `taskStatusChanged`.

### `client/src/lib/apiClient.js`

Reusable API helper.

Responsibilities:

- Defines API base URL.
- Adds retry logic.
- Sanitizes API error messages.
- Exports `getWithRetry`, `postWithRetry`, and `putWithRetry`.

Important functions:

- `sanitizeApiError(error, fallback)`: returns user-safe error message.
- `requestWithRetry(requestFn, options)`: retries transient request failures.
- `getWithRetry(path, options)`: GET helper.
- `postWithRetry(path, payload, options)`: POST helper.
- `putWithRetry(path, payload, options)`: PUT helper.

### `client/src/lib/realtime.js`

Defines Socket.IO client configuration.

Important exports:

- `ENABLE_REALTIME`: enabled only if `VITE_ENABLE_REALTIME=true`.
- `REALTIME_SOCKET_URL`: backend socket URL.
- `REALTIME_SOCKET_OPTIONS`: websocket/polling transport options.

### `client/src/components/Auth/Login.jsx`

Login UI.

Responsibilities:

- Captures email and password.
- Calls login handler from `App.jsx`.
- Displays authentication errors/loading state.

### `client/src/components/Auth/SetPassword.jsx`

First-login password setup UI.

Responsibilities:

- Allows an employee created by admin to set password.
- Sends password activation request.
- Shows success/error state.

### `client/src/components/Dashboard/AdminDashboard.jsx`

Main admin interface.

Responsibilities:

- Loads employees and productivity rankings.
- Displays team KPIs.
- Displays task assignment form.
- Adds new employees.
- Shows employee cards.
- Shows top performer and needs-attention employee.
- Shows AI/rule-based team recommendations.
- Supports dark/light mode.
- Refreshes data periodically.
- Refreshes on Socket.IO events.

Important functions:

- `toPercent(value, base)`: percentage helper.
- `getTrendMeta(stats)`: prepares trend label, icon, and style.
- `deriveStrengthTags({ ranking })`: identifies employee strengths.
- `getTaskActivityTimestamp(task)`: picks best task timestamp.
- `deriveCardSignalFallback(stats)`: creates fallback employee insight.
- `fetchDashboardData({ includeAI })`: loads employees and leaderboard.
- `refreshAiInsights()`: refreshes admin AI insights.
- `scheduleAiRefresh()`: debounces AI insight refresh after updates.
- `handleAddEmployee(event)`: creates a new employee.

### `client/src/components/Dashboard/EmployeeDashboard.jsx`

Main employee interface.

Responsibilities:

- Loads employee data.
- Displays focus tasks sorted by priority and date.
- Suggests next action.
- Shows weekly productivity comparison.
- Shows task count cards.
- Shows productivity dashboard.
- Shows task board.
- Supports dark/light mode.
- Polls and listens for real-time updates.

Important functions:

- `getPriorityWeight(priority)`: converts priority to sortable number.
- `getTaskDateTs(task)`: finds task date/timestamp.
- `getWeekBounds()`: calculates current and previous week boundaries.
- `fetchEmployee({ silent })`: refreshes employee data.
- `handleAccept()`: triggers dashboard refresh after task status change.

### `client/src/components/other/CreateTask.jsx`

Admin form for assigning a task.

Responsibilities:

- Captures employee email, task title, description, date, category, estimated duration, and acceptance time limit.
- Sends task creation request to `/api/employees/:email/tasks`.
- Clears form after success.

Important functions:

- `handleChange(e)`: updates form state.
- `handleSubmit(e)`: sends new task to backend.

### `client/src/components/other/Header.jsx`

Reusable header component.

Responsibilities:

- Displays greeting/user identity.
- Provides logout action.
- Supports theme-aware styling.

### `client/src/components/other/TaskListNumbers.jsx`

Task count summary cards.

Responsibilities:

- Displays counts of new, active, completed, and failed tasks.
- Used in employee dashboard.

### `client/src/components/other/AllTask.jsx`

Legacy or support component for listing all tasks.

### `client/src/components/other/AllUsers.jsx`

Legacy or support component for listing all users/employees.

### `client/src/components/TaskList/TaskList.jsx`

Task board controller.

Responsibilities:

- Filters tasks by status.
- Sorts tasks by timestamp and priority.
- Renders the correct task card component.
- Manages horizontal scrolling and custom scrollbar.
- Opens AI explanation modal.
- Caches explained task IDs in `localStorage`.
- Preserves modal state when real-time data updates arrive.

Important functions:

- `getTaskId(task)`: stable task ID.
- `matchesFilter(task, filter)`: decides whether a task appears for selected filter.
- `getTaskTimestamp(task)`: resolves task sort timestamp.
- `hasValidExplanation(payload)`: validates AI explanation response.
- `updateScrollState()`: updates custom scrollbar state.
- `handleExplain(task)`: fetches or opens cached task explanation.
- `handleCloseModal()`: closes modal and highlights the explained task.

### `client/src/components/TaskList/NewTask.jsx`

Task card for newly assigned tasks.

Responsibilities:

- Displays pending task.
- Shows AI priority.
- Shows acceptance deadline timer.
- Lets employee accept the task.
- Marks task as not accepted if the acceptance window expires.

Important functions:

- `computeTaskCounts(tasks)`: recalculates counts after state changes.
- `markTaskAsNotAccepted()`: updates expired task status.
- `acceptHandler()`: changes task from new to active.
- `updateTaskStatus(statusType)`: can mark task complete/failed when needed.

### `client/src/components/TaskList/AcceptTask.jsx`

Task card for active tasks.

Responsibilities:

- Displays active task details.
- Shows AI priority and deadline timer.
- Lets employee mark task as completed or failed.
- Shows AI insight/checklist when available.
- Caches task AI guidance in `localStorage`.

Important functions:

- `makeTaskIdentity(task)`: stable ID for caching.
- `buildCacheKey(task)`: builds localStorage key.
- `normalizeSteps(steps)`: cleans checklist steps.
- `buildChecklistItems(steps, checkedMap)`: creates checklist items.
- `readCachedInsight(cacheKey)`: reads cached AI guidance.
- `writeCachedInsight(cacheKey, payload)`: writes cached AI guidance.
- `updateTaskStatus(statusType)`: sends completed/failed update.
- `loadInsights()`: opens AI explanation or fetches it.
- `toggleChecklistItem(itemId)`: marks checklist step done/undone.

### `client/src/components/TaskList/CompleteTask.jsx`

Task card for completed tasks.

Responsibilities:

- Displays completed task details.
- Shows completion time.
- Shows AI guidance if available.
- Supports soft delete.

Important functions:

- `formatCompletionDuration(minutes)`: formats completion time.
- `handleDelete()`: hides task from UI while preserving analytics history.

### `client/src/components/TaskList/FailedTask.jsx`

Task card for failed tasks.

Responsibilities:

- Displays failed task details.
- Shows AI guidance if available.
- Supports soft delete.

Important function:

- `handleDelete()`: hides failed task from UI while preserving analytics history.

### `client/src/components/TaskList/TaskDeadlineTimer.jsx`

Deadline countdown component.

Responsibilities:

- Shows remaining time for task acceptance or completion.
- Helps users understand urgency.

### `client/src/components/TaskList/TaskAIInsight.jsx`

Small UI component for displaying task explanation, checklist, or AI guidance inside task cards.

### `client/src/components/ExplainTaskModal.jsx`

Modal for detailed AI task explanation.

Responsibilities:

- Displays task summary.
- Displays AI-generated steps.
- Displays estimated time.
- Provides checklist behavior.
- Stores checklist completion in `localStorage`.
- Supports dark/light mode.
- Closes on backdrop click.

Important functions:

- `checklistItems`: memoized list of explanation steps.
- `toggleChecklistItem(itemId)`: checks/unchecks steps.
- `handleBackdropClick(e)`: closes modal when user clicks outside.

### `client/src/components/ProductivityDashboard.jsx`

Employee productivity dashboard component.

Responsibilities:

- Fetches employee stats.
- Fetches chart data.
- Fetches productivity insights.
- Shows productivity score, weekly delta, charts, and AI/rule-based insights.
- Listens to real-time updates.
- Refreshes data periodically.

Important functions:

- `fetchProductivityData(...)`: loads stats, charts, and insights.
- `refreshData()`: updates dashboard after Socket.IO events.
- `MetricCard(...)`: renders metric cards.

### `client/src/components/Dashboard/ProductivityDashboard.jsx`

There is also a dashboard-scoped productivity dashboard file. It appears to be a related or older dashboard variant. The main employee dashboard currently imports `../ProductivityDashboard`.

### `client/src/components/Dashboard/AdminEmployeeProductivity.jsx`

Admin-side employee productivity display component. It is intended for showing per-employee productivity details.

### `client/src/components/Dashboard/AdminProductivityLeaderboard.jsx`

Admin-side leaderboard component. It supports the idea of ranking employees by productivity metrics.

### `client/src/components/Dashboard/AdminInsightsPanel.jsx`

Admin-side AI insights panel. It supports displaying AI/team recommendations.

### `client/src/components/Dashboard/AdminCompetitivePole.jsx`

Admin-side competitive comparison component. It supports visual comparison/ranking of employees.

### `client/src/utils/localStorage.jsx`

Local demo data and localStorage helper.

Responsibilities:

- Contains sample employee/admin data.
- Provides `setLocalStorage()`.
- Provides `getLocalStorage()`.

This appears to be older/demo support. The current app primarily uses MongoDB through the API.

### `client/localstorage.jsx`

Root-level localStorage/demo file. It appears to be older support code and is not part of the main current app flow.

### `client/src/App.css` and `client/src/index.css`

Styling files.

Responsibilities:

- Global CSS.
- Tailwind imports/configured classes.
- App-wide visual styling.

## Root configuration and documentation files

### `package.json`

Root package definition for deployment/shared backend dependencies.

Important dependencies:

- Express.
- Mongoose.
- Socket.IO.
- Groq SDK.
- CORS.
- Body parser.

### `client/package.json`

Frontend package definition.

Important scripts:

- `npm run dev`: starts Vite dev server.
- `npm run build`: builds frontend.
- `npm run preview`: previews frontend build.
- `npm run lint`: runs ESLint.

### `server/package.json`

Backend package definition.

Important scripts:

- `npm start`: starts backend.
- `npm run dev`: starts backend.

### `vercel.json`

Vercel deployment configuration.

Responsibilities:

- Routes frontend requests.
- Routes backend/API requests.
- Supports deployment of React + Express API through Vercel.

### `README.md`

General project description, setup instructions, tech stack, and usage notes.

### `SETUP_INSTRUCTIONS.md`

Detailed setup and deployment instructions.

### `AI_SYSTEM_FIXES.md`

Notes about fixes related to the AI system.

### `COMPLETE_UPGRADE_SUMMARY.md`

Summary of larger upgrades made to the project.

### `DELETE_TASK_FIX.md`

Explains the task delete/soft-delete fix.

### `PROJECT_CAPSTONE_REPORT_DRAFT.md`

Existing draft report for capstone/research presentation.

## Main app workflows

### Admin creates employee

1. Admin logs in.
2. Admin opens Add Employee form.
3. Frontend sends `POST /api/employees`.
4. Backend creates employee with no active password.
5. Employee account is marked as first-login pending.
6. Employee later sets password.

### Employee activates account

1. Employee enters email/password or goes through signup flow.
2. Backend checks whether employee exists.
3. If password is not set, backend requires password setup.
4. Employee sets password.
5. Employee account becomes activated.

### Admin assigns task

1. Admin fills Create Task form.
2. Frontend sends `POST /api/employees/:email/tasks`.
3. Backend creates task with status `newTask`.
4. Backend sets assigned/created timestamps.
5. Backend computes acceptance deadline if needed.
6. Backend returns employee data.
7. Backend starts background AI enrichment for priority and estimated duration.
8. Socket.IO events update dashboards.

### Employee accepts task

1. Employee sees task under pending/new tasks.
2. Employee clicks Accept Task.
3. Frontend fetches employee, updates task flags:
   - `newTask=false`
   - `active=true`
   - `acceptedAt=now`
   - `startedAt=now`
4. Frontend sends `PUT /api/employees/:email`.
5. Backend updates database and emits real-time updates.

### Employee completes or fails task

1. Employee clicks Mark as completed or Mark as failed.
2. Frontend updates task status.
3. Backend calculates/normalizes completion metadata.
4. Backend updates `completionTime` and `onTime`.
5. Backend clears old stored insights if outcome changed.
6. Backend emits `taskActionCompleted`.
7. Productivity dashboards refresh.

### AI explains task

1. Employee clicks AI Insights or Explain Task.
2. Frontend sends `POST /api/gemini/explain-task`.
3. Backend checks cached explanation.
4. If no cached explanation exists, backend calls AI.
5. Backend validates AI response.
6. Backend stores explanation in the task.
7. Frontend shows summary, steps, and checklist.

### Productivity dashboard loads

1. Frontend requests:
   - `/api/productivity/:employeeId/stats`
   - `/api/productivity/:employeeId/chart-data`
   - `/api/productivity/:employeeId/insights`
2. Backend calculates metrics from tasks.
3. Backend returns chart data and insights.
4. Frontend renders cards, charts, and recommendations.

### Admin leaderboard loads

1. Admin dashboard requests `/api/productivity/rankings`.
2. Backend loads all employees.
3. Backend computes stats for each employee.
4. Backend sorts by productivity score.
5. Backend produces team summary.
6. Backend generates AI or rule-based admin insights.

## Current AI capabilities

The app currently uses AI in three main areas:

1. Task priority and estimated duration

   When a task is created, the backend asks AI to classify priority and estimate effort. If AI fails, rule-based fallback is used.

2. Task explanation

   The employee can request task guidance. AI returns summary, step-by-step checklist, and estimated time.

3. Productivity insights

   The backend sends structured productivity data to AI to generate employee-level and admin/team-level patterns, recommendations, and risk signals.

## Current rule-based intelligence

The system does not depend only on AI. It also has rule-based analytics.

Examples:

- Productivity score = completed tasks multiplied by 2, minus failed tasks.
- Completion rate = completed tasks divided by total visible tasks.
- Average completion time from timestamps.
- On-time percentage from deadline comparison.
- Trend classification from recent and previous 7-day completion counts.
- Task timeout logic for missed acceptance and missed completion windows.
- Fallback priority from keywords, complexity, duration, and workload.
- Fallback productivity insights from actual metrics.

This is important for a research paper because you can compare:

- Rule-based baseline system.
- LLM-assisted system.
- Future ML model predictions.

## Dataset planning for ML model

Based on the current project, a useful dataset should contain task-level and employee-level productivity data.

### Ideal task-level dataset columns

Look for or create a dataset with columns like:

- `employee_id`
- `task_id`
- `task_title`
- `task_description`
- `task_category`
- `assigned_at`
- `accepted_at`
- `started_at`
- `completed_at`
- `deadline`
- `estimated_duration_minutes`
- `actual_completion_time_minutes`
- `task_complexity`
- `priority`
- `status`
- `on_time`
- `failed`
- `not_accepted`
- `active_tasks_at_assignment`
- `employee_workload`
- `day_of_week`
- `hour_of_day`

### Ideal employee-level dataset columns

- `employee_id`
- `total_tasks`
- `completed_tasks`
- `failed_tasks`
- `active_tasks`
- `new_tasks`
- `completion_rate`
- `average_completion_time`
- `on_time_percentage`
- `productivity_score`
- `completed_last_7_days`
- `completed_previous_7_days`
- `trend_delta`
- `peak_productivity_hour`
- `role`
- `department`
- `experience_level`

### Useful target variables for ML

You can train different models depending on your research question.

Possible targets:

- Predict task priority: High, Medium, Low.
- Predict whether task will be completed on time: yes/no.
- Predict task completion duration in minutes.
- Predict task failure risk: low/medium/high or yes/no.
- Predict employee productivity score.
- Recommend best employee for a new task.
- Predict if task acceptance will be delayed or missed.

### Best model ideas for this project

1. Task priority classification

   Input: task title, description, category, deadline, estimated duration, complexity, workload.

   Output: High, Medium, Low.

   Models:

   - Logistic Regression.
   - Random Forest.
   - XGBoost/LightGBM.
   - BERT or sentence embeddings + classifier for task text.

2. On-time completion prediction

   Input: employee history, task metadata, priority, workload, deadline gap.

   Output: on-time or delayed.

   Models:

   - Random Forest.
   - Gradient Boosting.
   - Logistic Regression baseline.

3. Completion time regression

   Input: task category, complexity, description length, priority, employee history.

   Output: predicted duration in minutes.

   Models:

   - Linear Regression baseline.
   - Random Forest Regressor.
   - XGBoost Regressor.

4. Employee-task recommendation

   Input: employee productivity patterns and task category.

   Output: best employee or suitability score.

   Models:

   - Ranking model.
   - Collaborative filtering style model.
   - Multi-class classifier.
   - Rule-based baseline using completion rate and specialization.

5. Productivity trend prediction

   Input: weekly task completion history.

   Output: improving, stable, declining.

   Models:

   - Time-series features + classifier.
   - LSTM if enough sequential data exists.
   - Gradient boosting with lag features.

## Dataset search keywords

Use these search terms when looking for public datasets:

- employee productivity dataset
- task completion dataset
- project management task dataset
- software issue tracking dataset
- Jira issue tracking dataset
- GitHub issues dataset
- developer productivity dataset
- workplace productivity dataset
- time tracking dataset
- task duration prediction dataset
- deadline completion prediction dataset
- employee performance dataset
- workflow management dataset

Good dataset sources:

- Kaggle.
- UCI Machine Learning Repository.
- GitHub public issue datasets.
- OpenML.
- Zenodo.
- Public Jira datasets.
- GitHub Archive.

For a realistic research paper, GitHub/Jira issue datasets are especially useful because issues naturally contain:

- Title.
- Description.
- Labels/category.
- Assignee.
- Created date.
- Closed date.
- Status.
- Priority/severity labels.
- Comments/activity.

These can be mapped to your task management system.

## How external datasets can map to this project

### Jira/GitHub issue dataset mapping

- Issue title -> `taskTitle`
- Issue body -> `taskDescription`
- Labels -> `category` or `priority`
- Assignee -> `employee`
- Created date -> `assignedAt`
- Closed date -> `completedAt`
- Issue state closed -> `completed`
- Issue state open for too long -> `active` or delayed
- Milestone/due date -> `taskDate`
- Time from created to closed -> `completionTime`

### Employee performance dataset mapping

- Employee ID -> `employee_id`
- Department -> category/specialization feature
- Performance score -> productivity label
- Hours worked -> workload feature
- Projects completed -> completed task count
- Absenteeism/delay -> risk feature

## Research paper direction

### Possible title

AI-Driven Task Management System Using Productivity Pattern Analysis and Predictive Task Prioritization

### Problem statement

Traditional task management systems track tasks but often fail to understand productivity patterns, workload pressure, deadline risk, and employee-specific work behavior. This project proposes an AI-assisted task management system that analyzes task metadata and employee activity to prioritize tasks, generate execution guidance, and provide productivity insights for both employees and administrators.

### Objectives

- Build a full-stack task management system.
- Track task lifecycle from assignment to completion/failure.
- Generate AI-assisted task priority and guidance.
- Analyze productivity patterns using completion rate, completion time, trend, and on-time delivery.
- Provide admin dashboard for team comparison.
- Explore ML models for priority prediction, completion-time prediction, and productivity forecasting.

### Research questions

- Can task metadata and employee history predict whether a task will be completed on time?
- Can machine learning predict task priority better than a rule-based baseline?
- Which features most affect employee productivity?
- Does AI-generated task guidance improve task completion behavior?
- Can productivity trend analysis help admins assign tasks more effectively?

### Hypotheses

- H1: Task complexity, deadline gap, and employee workload significantly affect task completion time.
- H2: Historical completion rate and average completion time can predict future task success.
- H3: AI-assisted task guidance can reduce failed tasks and improve on-time completion.
- H4: A trained ML model can outperform simple rule-based priority assignment.

### Methodology

1. Collect task and employee productivity data.
2. Clean and preprocess text, timestamps, categories, and status labels.
3. Engineer features:
   - Description length.
   - Deadline gap.
   - Active workload.
   - Historical completion rate.
   - Average completion time.
   - Category frequency.
   - Priority.
   - Day/hour features.
4. Train baseline rule-based model.
5. Train ML models for selected prediction task.
6. Evaluate using classification or regression metrics.
7. Integrate best model into the app.
8. Compare app behavior before and after model integration.

### Evaluation metrics

For classification:

- Accuracy.
- Precision.
- Recall.
- F1-score.
- Confusion matrix.
- ROC-AUC for binary targets.

For regression:

- MAE.
- RMSE.
- R2 score.

For recommendation/ranking:

- Top-k accuracy.
- Mean reciprocal rank.
- NDCG.

## Feature engineering ideas

Useful features from existing app data:

- `descriptionLength`: number of characters/words in task description.
- `deadlineGapMinutes`: deadline minus assigned time.
- `acceptanceDelayMinutes`: accepted time minus assigned time.
- `completionTimeMinutes`: completed time minus started/accepted time.
- `activeTasksAtAssignment`: active workload when assigned.
- `employeeCompletionRate`: employee historical completion rate.
- `employeeFailureRate`: historical failure ratio.
- `employeeAvgCompletionTime`: average completion duration.
- `categorySuccessRate`: employee success rate for the same task category.
- `priorityEncoded`: High=3, Medium=2, Low=1.
- `dayOfWeek`: assigned/completed day.
- `hourOfDay`: assigned/completed hour.
- `isWeekend`: weekend task flag.
- `recentTrendDelta`: last 7 days minus previous 7 days.

## Suggested future functionality based on ML results

### Smart task assignment

Recommend the best employee for a new task based on category expertise, workload, completion history, and predicted on-time probability.

### Deadline risk warning

Show warning when a task has high probability of late completion.

### Workload balancing

Detect overloaded and underutilized employees automatically.

### Personalized productivity coaching

Generate recommendations based on each employee's peak hours, failure patterns, and completion behavior.

### AI-enhanced priority model

Replace or supplement LLM-only priority with a trained ML model that uses historical outcomes.

### Completion time prediction

Predict expected duration before assigning the task.

### Task clustering

Cluster task categories and employee strengths to identify specialization areas.

### Research experiment mode

Add a feature to export anonymized task logs as CSV for model training and paper experiments.

### Feedback loop

After task completion, collect employee feedback:

- Was the AI priority correct?
- Was estimated duration accurate?
- Were AI steps useful?
- What blocked the task?

This feedback can become training data.

## Recommended new files/features to add later

### Backend

- `server/api/mlRoutes.js`

  API endpoints for ML predictions:

  - `/api/ml/predict-priority`
  - `/api/ml/predict-completion-time`
  - `/api/ml/predict-delay-risk`
  - `/api/ml/recommend-assignee`

- `server/utils/featureEngineering.js`

  Converts task and employee data into ML-ready features.

- `server/api/exportRoutes.js`

  Exports anonymized task dataset as CSV/JSON.

### Frontend

- `client/src/components/Dashboard/MLPredictionPanel.jsx`

  Shows predicted priority, delay risk, and expected duration.

- `client/src/components/Dashboard/WorkloadBalancer.jsx`

  Shows overloaded/underutilized employee recommendations.

- `client/src/components/Research/DatasetExport.jsx`

  Lets admin export data for research.

## Strengths of this project

- Full-stack implementation with real database.
- Role-based admin/employee experience.
- Task lifecycle tracking.
- AI-generated task priority and guidance.
- Real-time updates with Socket.IO.
- Productivity analytics and charts.
- Admin leaderboard and team insights.
- Rule-based fallback when AI fails.
- Data fields already suitable for future ML research.
- Soft delete preserves analytical history.

## Limitations to mention honestly

- Passwords are stored as plain text in the current code; production systems should use hashing such as bcrypt.
- There is no JWT/session-token based secure authentication yet.
- The app currently uses embedded tasks inside employee documents, which is simple but may become harder to scale for large datasets.
- Some files are legacy/demo support and could be cleaned up.
- Current AI outputs depend on external API availability and rate limits.
- ML model is not yet trained/integrated; current intelligence is LLM + rule-based analytics.
- Dataset size from demo usage may be too small, so external or generated datasets are needed for research.

## Best presentation structure

1. Introduction

   Explain the problem: task systems track work but do not deeply analyze productivity behavior.

2. Objective

   Build an AI-driven task management system that helps assign, prioritize, track, and analyze tasks.

3. System architecture

   Show React frontend, Express backend, MongoDB database, AI provider, and Socket.IO.

4. Core modules

   Explain admin dashboard, employee dashboard, task lifecycle, AI insights, and productivity analytics.

5. Data collected

   Explain task metadata, timestamps, completion status, priority, and productivity metrics.

6. AI features

   Explain priority prediction, task explanation, and productivity recommendations.

7. Research/ML extension

   Explain how dataset will be used to train models for priority, completion time, delay risk, or assignee recommendation.

8. Results expected

   Better task planning, workload balance, productivity visibility, and data-driven decision making.

9. Future scope

   ML model integration, dataset export, smart assignment, risk prediction, and secure authentication.

## One-line project definition

This project is an AI-assisted employee task management and productivity analytics platform that tracks task lifecycles, analyzes employee performance patterns, generates AI task guidance, and provides a foundation for machine learning research on task prioritization, completion prediction, and productivity improvement.

