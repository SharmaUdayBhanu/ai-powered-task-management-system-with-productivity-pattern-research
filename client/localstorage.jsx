
export const addTaskToLocalStorage = (employeeId, newTask) => {
  // Retrieve existing tasks from local storage
  const tasks = JSON.parse(localStorage.getItem('tasks')) || {};

  // Add the new task to the specific employee's task list
  if (!tasks[employeeId]) {
    tasks[employeeId] = [];
  }
  tasks[employeeId].push(newTask);

  // Save the updated tasks back to local storage
  localStorage.setItem('tasks', JSON.stringify(tasks));
};

export const getTasksFromLocalStorage = (employeeId) => {
  const tasks = JSON.parse(localStorage.getItem('tasks')) || {};
  return tasks[employeeId] || [];
};