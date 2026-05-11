import mongoose from "mongoose";

// Task schema with richer analytics / AI fields
export const taskSchema = new mongoose.Schema({
  active: { type: Boolean, default: false },
  newTask: { type: Boolean, default: true },
  completed: { type: Boolean, default: false },
  failed: { type: Boolean, default: false },
  taskTitle: { type: String, required: true },
  taskDescription: { type: String, required: true },
  taskDate: { type: String },
  category: { type: String },

  // AI priority + analytics fields
  aiPriority: {
    type: String,
    enum: ["High", "Medium", "Low"],
    default: "Medium",
  },
  aiPriorityReason: { type: String },
  aiEstimationPending: { type: Boolean, default: false },

  assignedAt: { type: Date },
  createdAt: { type: Date },
  acceptedAt: { type: Date },
  startedAt: { type: Date },
  submittedAt: { type: Date },
  completedAt: { type: Date },

  complexity: { type: Number, min: 1, max: 5 },
  estimatedDuration: { type: Number }, // minutes
  acceptanceTimeLimitMinutes: { type: Number },
  acceptanceDeadline: { type: Date },
  notAccepted: { type: Boolean, default: false },
  effortLevel: { type: Number, min: 1, max: 5 },
  cognitiveLoadScore: { type: Number, min: 0, max: 100 },

  completionTime: { type: Number }, // minutes
  onTime: { type: Boolean, default: true },
  insights: { type: String },

  // Gemini explain-task cache
  explainSummary: { type: String },
  explainSteps: [{ type: String }],
  explainStepChecks: [{ type: Boolean }],
  explainEstimatedTime: { type: String },
  explainSource: { type: String, enum: ["AI", "System"], default: "System" },

  // Group-task metadata. Individual tasks remain fully backward compatible.
  groupTask: { type: Boolean, default: false },
  groupId: { type: String },
  groupMembers: [
    {
      email: String,
      name: String,
      role: String,
      inferredSpeciality: String,
      accepted: { type: Boolean, default: false },
      acceptedAt: Date,
    },
  ],
  groupAcceptedEmails: [{ type: String }],
  groupStepAssignments: [
    {
      step: String,
      assignedEmail: String,
      assignedName: String,
      completed: { type: Boolean, default: false },
      completedBy: String,
      completedAt: Date,
    },
  ],
  groupMemberEstimates: [
    {
      email: String,
      estimatedMinutes: Number,
    },
  ],

  chatEnabled: { type: Boolean, default: false },
  chatClosed: { type: Boolean, default: false },
  chatMessages: [
    {
      messageId: { type: String },
      senderName: { type: String },
      senderEmail: { type: String },
      senderRole: { type: String },
      message: { type: String },
      createdAt: { type: Date },
      type: {
        type: String,
        enum: ["user", "system", "assistant"],
        default: "user",
      },
    },
  ],

  // Soft delete flag - tasks marked as deleted are hidden from UI but kept in analytics
  isDeleted: { type: Boolean, default: false },
  deletedAt: { type: Date },
});

export const employeeSchema = new mongoose.Schema({
  firstName: String,
  lastName: String,
  email: { type: String, unique: true },
  password: String,
  role: { type: String, default: "employee" },
  isFirstLogin: { type: Boolean, default: true },
  isPasswordSet: { type: Boolean, default: false },
  isActivated: { type: Boolean, default: false },
  inferredSpeciality: { type: String },
  isArchived: { type: Boolean, default: false },
  archivedAt: { type: Date },
  taskCounts: {
    active: { type: Number, default: 0 },
    newTask: { type: Number, default: 0 },
    completed: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
  },
  tasks: [taskSchema],
  // Stored AI insights and analytics
  storedInsights: [{ type: String }],
  storedChartData: {
    tasksPerDay: [{ date: String, dateLabel: String, count: Number }],
    completionDurationDots: [
      {
        taskTitle: String,
        completedAtTs: Number,
        dateLabel: String,
        completionTimeMinutes: Number,
      },
    ],
    averageCompletionTimeMinutes: Number,
    productivityTrendDelta: Number,
    windowDays: Number,
  },
  lastInsightUpdate: { type: Date },
  lastChartUpdate: { type: Date },
});

export const adminSchema = new mongoose.Schema({
  email: { type: String, unique: true },
  password: String,
});

export const Employee = mongoose.model("Employee", employeeSchema);
export const Admin = mongoose.model("Admin", adminSchema);
