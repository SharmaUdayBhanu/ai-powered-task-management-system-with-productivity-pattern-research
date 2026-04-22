// Simple rule-based priority computation using description, length, and basic flags
export function computeRuleBasedPriority(task, employee) {
  const description = (task.taskDescription || "").toLowerCase();
  const title = (task.taskTitle || "").toLowerCase();
  const text = `${title} ${description}`;

  let score = 0;

  const urgentKeywords = ["urgent", "asap", "immediately", "critical", "high priority"];
  const mediumKeywords = ["soon", "this week", "important"];

  urgentKeywords.forEach((kw) => {
    if (text.includes(kw)) score += 3;
  });

  mediumKeywords.forEach((kw) => {
    if (text.includes(kw)) score += 2;
  });

  // Longer descriptions are treated as more complex
  const length = description.length;
  if (length > 400) score += 3;
  else if (length > 200) score += 2;
  else if (length > 80) score += 1;

  // Use existing complexity / estimatedDuration if present
  if (typeof task.complexity === "number") {
    score += task.complexity;
  }
  if (typeof task.estimatedDuration === "number") {
    if (task.estimatedDuration > 240) score += 3;
    else if (task.estimatedDuration > 120) score += 2;
    else if (task.estimatedDuration > 60) score += 1;
  }

  // Rough adjustment based on employee's current active tasks (cognitive load)
  let activeCount = 0;
  if (employee && Array.isArray(employee.tasks)) {
    activeCount = employee.tasks.filter((t) => t.active).length;
  }
  if (activeCount >= 5) {
    score -= 2; // avoid overloading already-busy employees
  } else if (activeCount === 0) {
    score += 1; // free to take on important work
  }

  let priority = "Medium";
  if (score >= 7) priority = "High";
  else if (score <= 3) priority = "Low";

  return {
    priority,
    reason: `Score ${score} based on keywords, description length, and current active tasks (${activeCount}).`,
  };
}


