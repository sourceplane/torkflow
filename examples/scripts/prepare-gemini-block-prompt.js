(() => {
  const todo = Steps.Fetch_Todo.json;
  const user = Steps.Fetch_User.json;
  const post = Steps.Fetch_Post.json;

  const prompt = [
    "Create a Slack Block Kit JSON ARRAY only.",
    "Return raw JSON only. No markdown. No explanation.",
    "Use max 5 blocks.",
    "Include:",
    "1) header",
    "2) section with concise status summary",
    "3) section with fields: owner, email, priority",
    "4) context with execution source note",
    "5) actions button to open URL",
    "",
    "DATA:",
    `todoId: ${todo.id}`,
    `todoTitle: ${todo.title}`,
    `todoCompleted: ${todo.completed}`,
    `ownerName: ${user.name}`,
    `ownerEmail: ${user.email}`,
    `priorityHint: ${todo.completed ? "low" : "high"}`,
    `referenceUrl: https://jsonplaceholder.typicode.com/todos/${todo.id}`,
    `extraContextTitle: ${post.title}`
  ].join("\n");

  return {
    prompt,
    fallback: {
      text: `TODO #${todo.id} ${todo.completed ? "completed" : "open"} · ${todo.title}`,
      owner: user.name,
      ownerEmail: user.email,
      priority: todo.completed ? "low" : "high",
      referenceUrl: `https://jsonplaceholder.typicode.com/todos/${todo.id}`
    }
  };
})()
