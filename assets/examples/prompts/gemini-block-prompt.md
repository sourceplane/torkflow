Create a Slack Block Kit JSON ARRAY only.
Return raw JSON only. No markdown. No explanation.
Use max 5 blocks.
Include:
1) header
2) section with concise status summary
3) section with fields: owner, email, priority
4) context with execution source note
5) actions button to open URL

DATA:
todoId: {{ Steps.Fetch_Todo.json.id }}
todoTitle: {{ Steps.Fetch_Todo.json.title }}
todoCompleted: {{ Steps.Fetch_Todo.json.completed }}
ownerName: {{ Steps.Fetch_User.json.name }}
ownerEmail: {{ Steps.Fetch_User.json.email }}
priorityHint: {{ Steps.Fetch_Todo.json.completed ? 'low' : 'high' }}
referenceUrl: https://jsonplaceholder.typicode.com/todos/{{ Steps.Fetch_Todo.json.id }}
extraContextTitle: {{ Steps.Fetch_Post.json.title }}
