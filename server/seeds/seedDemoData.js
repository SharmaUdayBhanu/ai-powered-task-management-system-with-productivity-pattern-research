import mongoose from "mongoose";
import dotenv from "dotenv";
import { Employee, Admin } from "../models.js";
import { computeRuleBasedPriority } from "../utils/priorityUtils.js";

dotenv.config();

const employeesBlueprint = [
  {
    firstName: "Arjun",
    lastName: "Sharma",
    email: "arjun@example.com",
    password: "arjun123",
    persona: "top",
    tasksCount: 20,
    distribution: { completed: 17, failed: 1, active: 2 },
  },
  {
    firstName: "Priya",
    lastName: "Verma",
    email: "priya@example.com",
    password: "priya123",
    persona: "consistent",
    tasksCount: 16,
    distribution: { completed: 10, failed: 3, active: 3 },
  },
  {
    firstName: "Suresh",
    lastName: "Patel",
    email: "suresh@example.com",
    password: "suresh123",
    persona: "risk",
    tasksCount: 16,
    distribution: { completed: 5, failed: 8, active: 3 },
  },
  {
    firstName: "Bhanu",
    lastName: "Sharma",
    email: "bhanu@gmail.com",
    password: "bhanu123",
    persona: "demo",
    tasksCount: 3,
    distribution: { completed: 1, failed: 0, active: 1, newTask: 1 },
  },
];

const taskLibrary = [
  {
    title: "Client onboarding workshop",
    description:
      "Run the onboarding session and capture follow-up actions with owners.",
    category: "Meeting",
  },
  {
    title: "Refactor notification service",
    description:
      "Refactor notification handlers and validate log coverage for alert events.",
    category: "Development",
  },
  {
    title: "Quarterly compliance checklist",
    description:
      "Prepare compliance evidence and upload signed checklist to audit folder.",
    category: "Documentation",
  },
  {
    title: "UX review for employee dashboard",
    description:
      "Review onboarding and task board flows and list top usability fixes.",
    category: "Design",
  },
  {
    title: "Data pipeline health metrics",
    description:
      "Track ETL latency, failures and throughput to improve reliability alerts.",
    category: "Analytics",
  },
  {
    title: "Incident postmortem report",
    description:
      "Document incident timeline, root cause and next preventive actions.",
    category: "Reporting",
  },
  {
    title: "Optimize cache layer",
    description:
      "Improve cache hit rate by tuning route-specific TTLs and invalidation logic.",
    category: "Performance",
  },
  {
    title: "Customer sentiment summary",
    description:
      "Summarize customer feedback patterns and propose top three service improvements.",
    category: "Research",
  },
  {
    title: "API reliability review",
    description:
      "Review API error trends and suggest retry/backoff improvements for key endpoints.",
    category: "Engineering",
  },
  {
    title: "Knowledge base cleanup",
    description:
      "Clean outdated knowledge articles and update process steps for support team.",
    category: "Support",
  },
];

const dayMs = 24 * 60 * 60 * 1000;

const performanceConfig = {
  top: {
    completionDurationRange: [55, 95],
    failureDurationRange: [95, 150],
    activeElapsedRange: [35, 85],
    preferredHours: [9, 10, 11, 14, 15],
    dayWindow: 14,
    onTimeProbabilityPct: 86,
    deadlineCoveragePct: 85,
  },
  consistent: {
    completionDurationRange: [35, 70],
    failureDurationRange: [80, 130],
    activeElapsedRange: [45, 100],
    preferredHours: [10, 11, 13, 15, 16],
    dayWindow: 14,
    onTimeProbabilityPct: 78,
    deadlineCoveragePct: 80,
  },
  risk: {
    completionDurationRange: [120, 220],
    failureDurationRange: [170, 320],
    activeElapsedRange: [120, 240],
    preferredHours: [12, 14, 17, 19, 21],
    dayWindow: 14,
    onTimeProbabilityPct: 35,
    deadlineCoveragePct: 88,
  },
};

const deterministicDuration = (range, seed) => {
  const [min, max] = range;
  const spread = Math.max(1, max - min);
  return min + (seed % spread);
};

const makeStatusPlan = ({ completed = 0, failed = 0, active = 0, newTask = 0 }) => {
  const statuses = [
    ...Array(completed).fill("completed"),
    ...Array(failed).fill("failed"),
    ...Array(active).fill("active"),
    ...Array(newTask).fill("new"),
  ];

  const plan = [];
  let completedIdx = 0;
  let failedIdx = 0;
  let activeIdx = 0;
  let newIdx = 0;

  while (plan.length < statuses.length) {
    if (completedIdx < completed) {
      plan.push("completed");
      completedIdx += 1;
    }
    if (activeIdx < active) {
      plan.push("active");
      activeIdx += 1;
    }
    if (failedIdx < failed) {
      plan.push("failed");
      failedIdx += 1;
    }
    if (newIdx < newTask) {
      plan.push("new");
      newIdx += 1;
    }
  }

  return plan.slice(0, statuses.length);
};

const buildPatternedDayOffset = (i, persona, maxWindow) => {
  if (persona === "risk") {
    const pattern = [1, 1, 2, 2, 3, 4, 7, 7, 8, 10, 10, 11, 12, 13, 14, 14];
    return Math.min(pattern[i % pattern.length], maxWindow);
  }

  if (persona === "top") {
    const offset = 1 + ((i * 2 + 1) % maxWindow);
    return Math.min(offset, maxWindow);
  }

  return Math.min(1 + (i % maxWindow), maxWindow);
};

const shouldTaskHaveDeadline = (seed, coveragePct) =>
  (seed % 100) < coveragePct;

const shouldBeOnTime = (seed, probabilityPct) => (seed % 100) < probabilityPct;

const addPriorityMetadata = (tasks) =>
  tasks.map((task) => {
    const { priority, reason } = computeRuleBasedPriority(task, { tasks });
    return {
      ...task,
      aiPriority: priority,
      aiPriorityReason: reason,
    };
  });

const createBhanuDemoTasks = () => {
  const now = new Date();

  const baselineCreatedAt = new Date(now.getTime() - 9 * dayMs);
  baselineCreatedAt.setHours(12, 10, 0, 0);
  const baselineStartedAt = new Date(baselineCreatedAt.getTime() + 30 * 60 * 1000);
  const baselineCompletedAt = new Date(baselineStartedAt.getTime() + 95 * 60 * 1000);

  const activeCreatedAt = new Date(now.getTime() - 2 * dayMs);
  activeCreatedAt.setHours(11, 25, 0, 0);
  const activeStartedAt = new Date(activeCreatedAt.getTime() + 35 * 60 * 1000);

  const demoAssignedAt = new Date(now.getTime() - 35 * 60 * 1000);
  const demoDeadline = new Date(now.getTime() + dayMs);

  const tasks = [
    {
      taskTitle: "Prepare weekly productivity summary",
      taskDescription:
        "Compile completed tasks and blockers into a short weekly summary for the manager update.",
      category: "Analysis",
      taskDate: baselineCreatedAt.toISOString().slice(0, 10),
      createdAt: baselineCreatedAt,
      assignedAt: baselineCreatedAt,
      acceptedAt: new Date(baselineCreatedAt.getTime() + 15 * 60 * 1000),
      startedAt: baselineStartedAt,
      submittedAt: baselineCompletedAt,
      completedAt: baselineCompletedAt,
      complexity: 2,
      estimatedDuration: 120,
      completionTime: 95,
      onTime: true,
      effortLevel: 2,
      cognitiveLoadScore: 42,
      acceptanceTimeLimitMinutes: 180,
      notAccepted: false,
      newTask: false,
      active: false,
      completed: true,
      failed: false,
      insights: "Baseline completed task for trend initialization.",
    },
    {
      taskTitle: "Review KPI widget layout options",
      taskDescription:
        "Evaluate 2-3 layout options for KPI cards and prepare recommendation notes.",
      category: "Design",
      taskDate: activeCreatedAt.toISOString().slice(0, 10),
      createdAt: activeCreatedAt,
      assignedAt: activeCreatedAt,
      acceptedAt: new Date(activeCreatedAt.getTime() + 20 * 60 * 1000),
      startedAt: activeStartedAt,
      complexity: 2,
      estimatedDuration: 140,
      effortLevel: 2,
      cognitiveLoadScore: 48,
      acceptanceTimeLimitMinutes: 180,
      notAccepted: false,
      newTask: false,
      active: true,
      completed: false,
      failed: false,
      insights: "Current in-progress item for live dashboard context.",
    },
    {
      taskTitle: "Design a dashboard UI for employee productivity tracking",
      taskDescription:
        "Create a clean dashboard layout showing task metrics, performance trends, and AI insights for employees.",
      category: "Design / Development",
      taskDate: demoDeadline.toISOString().slice(0, 10),
      createdAt: demoAssignedAt,
      assignedAt: demoAssignedAt,
      complexity: 3,
      estimatedDuration: 210,
      acceptanceTimeLimitMinutes: 180,
      acceptanceDeadline: new Date(
        demoAssignedAt.getTime() + 180 * 60 * 1000,
      ),
      notAccepted: false,
      newTask: true,
      active: false,
      completed: false,
      failed: false,
      effortLevel: 3,
      cognitiveLoadScore: 56,
      insights:
        "Demo task prepared for live assignment and completion walkthrough.",
    },
  ];

  return addPriorityMetadata(tasks);
};

function generateTasksForEmployee(blueprint, employeeIndex) {
  if (blueprint.persona === "demo") {
    return createBhanuDemoTasks();
  }

  const tasks = [];
  const now = new Date();
  const config = performanceConfig[blueprint.persona];
  const statusPlan = makeStatusPlan(blueprint.distribution);

  for (let i = 0; i < blueprint.tasksCount; i += 1) {
    const lib = taskLibrary[i % taskLibrary.length];
    const status = statusPlan[i % statusPlan.length];

    const dayOffset = buildPatternedDayOffset(i, blueprint.persona, config.dayWindow);
    const createdAt = new Date(now.getTime() - dayOffset * dayMs);

    const preferredHour =
      config.preferredHours[i % config.preferredHours.length];
    createdAt.setHours(preferredHour, (i % 4) * 12, 0, 0);

    const acceptedAt = new Date(createdAt.getTime() + (15 + (i % 4) * 10) * 60 * 1000);
    const startedAt = new Date(acceptedAt.getTime() + (8 + (i % 4) * 7) * 60 * 1000);

    const complexity = 2 + (i % 3);
    const estimatedDuration =
      60 + complexity * 20 + (blueprint.persona === "risk" ? 20 : 0);

    const completedDuration = deterministicDuration(
      config.completionDurationRange,
      i * 17 + employeeIndex * 13,
    );
    const failedDuration = deterministicDuration(
      config.failureDurationRange,
      i * 19 + employeeIndex * 7,
    );
    const activeElapsed = deterministicDuration(
      config.activeElapsedRange,
      i * 11 + employeeIndex * 5,
    );

    const deadlineSeed = i * 31 + employeeIndex * 17;
    const hasDeadline = shouldTaskHaveDeadline(
      deadlineSeed,
      config.deadlineCoveragePct,
    );
    const dueDate = new Date(createdAt.getTime() + (1 + (i % 3)) * dayMs);
    const taskDate = hasDeadline ? dueDate.toISOString().slice(0, 10) : undefined;

    const baseTask = {
      taskTitle: `${lib.title} (${blueprint.firstName} ${i + 1})`,
      taskDescription: lib.description,
      category: lib.category,
      taskDate,
      createdAt,
      assignedAt: createdAt,
      acceptedAt,
      startedAt,
      complexity,
      estimatedDuration,
      effortLevel: 1 + (i % 5),
      cognitiveLoadScore: Math.min(100, 35 + i * 3),
      acceptanceTimeLimitMinutes: 120,
      notAccepted: false,
      newTask: false,
      active: false,
      completed: false,
      failed: false,
    };

    if (status === "completed") {
      const onTimeSeed = i * 43 + employeeIndex * 23;
      const shouldCompleteOnTime = hasDeadline
        ? shouldBeOnTime(onTimeSeed, config.onTimeProbabilityPct)
        : true;

      let completionMinutes = completedDuration;
      if (hasDeadline) {
        if (shouldCompleteOnTime) {
          completionMinutes = Math.min(completionMinutes, estimatedDuration - 5);
        } else {
          completionMinutes = Math.max(completionMinutes, estimatedDuration + 40);
        }
      }

      const completedAt = new Date(startedAt.getTime() + completionMinutes * 60 * 1000);

      tasks.push({
        ...baseTask,
        completed: true,
        failed: false,
        submittedAt: completedAt,
        completedAt,
        completionTime: completionMinutes,
        onTime: hasDeadline ? shouldCompleteOnTime : undefined,
        insights:
          blueprint.persona === "top"
            ? "Consistent delivery with predictable quality."
            : "Steady throughput with reliable execution.",
      });
      continue;
    }

    if (status === "failed") {
      const completedAt = new Date(
        startedAt.getTime() + failedDuration * 60 * 1000,
      );
      tasks.push({
        ...baseTask,
        completed: false,
        failed: true,
        completedAt,
        completionTime: failedDuration,
        onTime: false,
        insights:
          blueprint.persona === "risk"
            ? "Failure due to blockers, context switching, and missed checkpoints."
            : "Execution interrupted by blockers and dependency delays.",
      });
      continue;
    }

    if (status === "new") {
      const assignedAt = new Date(now.getTime() - (30 + i * 12) * 60 * 1000);
      const upcomingDeadline = new Date(now.getTime() + dayMs);
      tasks.push({
        ...baseTask,
        taskDate: upcomingDeadline.toISOString().slice(0, 10),
        createdAt: assignedAt,
        assignedAt,
        acceptedAt: undefined,
        startedAt: undefined,
        acceptanceDeadline: new Date(assignedAt.getTime() + 120 * 60 * 1000),
        newTask: true,
        active: false,
        completed: false,
        failed: false,
        completionTime: undefined,
        onTime: undefined,
        insights: "Newly assigned and awaiting acceptance.",
      });
      continue;
    }

    const nowInProgress = new Date(
      startedAt.getTime() + activeElapsed * 60 * 1000,
    );
    tasks.push({
      ...baseTask,
      active: true,
      completed: false,
      failed: false,
      completionTime: undefined,
      onTime: undefined,
      insights: `In progress for about ${activeElapsed} minutes.`,
      updatedAt: nowInProgress,
    });
  }

  return addPriorityMetadata(tasks);
}

const computeTaskCounts = (tasks) => ({
  newTask: tasks.filter((t) => t.newTask && !t.isDeleted && !t.notAccepted)
    .length,
  active: tasks.filter((t) => t.active && !t.isDeleted && !t.notAccepted)
    .length,
  completed: tasks.filter((t) => t.completed && !t.isDeleted && !t.notAccepted)
    .length,
  failed: tasks.filter((t) => t.failed && !t.isDeleted && !t.notAccepted)
    .length,
});

async function seed() {
  const mongoUri =
    process.env.MONGODB_URI || "mongodb://localhost:27017/jobportal";

  await mongoose.connect(mongoUri);
  console.log("Connected to MongoDB for seeding");

  await Employee.deleteMany({});
  await Admin.deleteMany({});

  await Admin.create({
    email: "admin@admins.com",
    password: "123",
  });

  for (let i = 0; i < employeesBlueprint.length; i += 1) {
    const blueprint = employeesBlueprint[i];
    const tasks = generateTasksForEmployee(blueprint, i);
    const taskCounts = computeTaskCounts(tasks);

    await Employee.create({
      firstName: blueprint.firstName,
      lastName: blueprint.lastName,
      email: blueprint.email,
      password: blueprint.password,
      role: "employee",
      isFirstLogin: false,
      isPasswordSet: true,
      isActivated: true,
      taskCounts,
      tasks,
    });

    console.log(
      `Seeded ${blueprint.firstName}: ${tasks.length} tasks (completed ${taskCounts.completed}, failed ${taskCounts.failed}, active ${taskCounts.active}, new ${taskCounts.newTask})`,
    );
  }

  await mongoose.disconnect();
  console.log("Seed data inserted successfully.");
}

seed().catch((err) => {
  console.error("Seeding error:", err);
  process.exit(1);
});
