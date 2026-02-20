const todo = Steps.Fetch_Todo.json;
const user = Steps.Fetch_User.json;
const fallback = {
  text: `TODO #${todo.id} ${todo.completed ? "completed" : "open"} · ${todo.title}`,
  owner: user.name,
  ownerEmail: user.email,
  priority: todo.completed ? "low" : "high",
  referenceUrl: `https://jsonplaceholder.typicode.com/todos/${todo.id}`
};

let blocks = [];

try {
  const cleaned = (Steps.Gemini_Format_Slack_Blocks.text || "")
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  const parsed = JSON.parse(cleaned);
  if (Array.isArray(parsed)) {
    blocks = parsed;
  }
} catch (_) {}

if (!Array.isArray(blocks) || blocks.length === 0) {
  blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: "⚠️ Workflow Notification", emoji: true }
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: fallback.text }
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Owner*\n${fallback.owner}` },
        { type: "mrkdwn", text: `*Email*\n${fallback.ownerEmail}` },
        { type: "mrkdwn", text: `*Priority*\n${fallback.priority}` }
      ]
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Open Todo", emoji: true },
          url: fallback.referenceUrl
        }
      ]
    }
  ];
}

const payload = {
  channel: "C0AFET2FMNE",
  text: fallback.text,
  blocks
};

return {
  rawBody: JSON.stringify(payload),
  preview: payload
};
