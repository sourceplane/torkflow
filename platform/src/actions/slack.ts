import {
  NonRetryableActionError,
  RetryableActionError,
  type ActionDescriptor,
  type ActionRequest,
  type ActionResult,
} from "./types.js";

/**
 * Slack actions.
 *
 * The CLI reaches Slack through raw `http.request.auth` calls; these wrap the
 * same API with typed input, a real credential type and Slack's own error
 * envelope translated into step failures. `chat.postMessage` returning
 * `{ok: false, error: "channel_not_found"}` is a 200 response, so an untyped
 * HTTP step would record it as a success — one of the things the Datadog-style
 * catalog is expected to get right.
 */

const SLACK_CREDENTIAL = {
  type: "object",
  required: ["botToken"],
  properties: { botToken: { type: "string", minLength: 1 } },
  additionalProperties: true,
} as const;

/** Slack errors that are worth another attempt. */
const RETRYABLE_SLACK_ERRORS = new Set([
  "ratelimited",
  "service_unavailable",
  "internal_error",
  "request_timeout",
  "fatal_error",
]);

async function slackCall(
  request: ActionRequest,
  method: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const credential = request.credential as { botToken?: string };
  if (!credential.botToken) {
    throw new NonRetryableActionError(`${request.actionRef} requires a botToken credential`);
  }

  let response: Response;
  try {
    response = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential.botToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(payload),
      signal: request.signal,
    });
  } catch (error) {
    throw new RetryableActionError(`slack: ${method} failed: ${(error as Error).message}`);
  }

  if (response.status === 429 || response.status >= 500) {
    throw new RetryableActionError(`slack: ${method} returned ${response.status}`);
  }

  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) throw new RetryableActionError(`slack: ${method} returned a malformed body`);

  if (body.ok !== true) {
    const error = String(body.error ?? "unknown_error");
    const message = `slack: ${method} failed: ${error}`;
    throw RETRYABLE_SLACK_ERRORS.has(error)
      ? new RetryableActionError(message)
      : new NonRetryableActionError(message);
  }
  return body;
}

export const slackActions: ActionDescriptor[] = [
  {
    name: "slack.postMessage",
    module: "slack",
    version: "1.0.0",
    description: "Post a message to a Slack channel",
    timeoutSeconds: 30,
    capabilities: ["supportsRetry"],
    credentialType: "slack.bot",
    credentialSchema: SLACK_CREDENTIAL as never,
    inputSchema: {
      type: "object",
      required: ["channel"],
      properties: {
        channel: { type: "string", minLength: 1 },
        text: { type: "string" },
        blocks: { type: "array" },
        threadTs: { type: "string" },
        unfurlLinks: { type: "boolean" },
      },
      additionalProperties: true,
    } as never,
    outputSchema: {
      type: "object",
      required: ["ok", "ts"],
      properties: {
        ok: { type: "boolean" },
        ts: { type: "string" },
        channel: { type: "string" },
        permalink: { type: "string" },
      },
      additionalProperties: true,
    } as never,
    handler: async (request): Promise<ActionResult> => {
      const input = request.input;
      const body = await slackCall(request, "chat.postMessage", {
        channel: input.channel,
        ...(input.text !== undefined ? { text: input.text } : {}),
        ...(input.blocks !== undefined ? { blocks: input.blocks } : {}),
        ...(input.threadTs !== undefined ? { thread_ts: input.threadTs } : {}),
        ...(input.unfurlLinks !== undefined ? { unfurl_links: input.unfurlLinks } : {}),
      });
      return {
        output: {
          ok: true,
          ts: String(body.ts ?? ""),
          channel: String(body.channel ?? ""),
          message: body.message ?? null,
        },
      };
    },
  },
  {
    name: "slack.getUserByEmail",
    module: "slack",
    version: "1.0.0",
    description: "Look up a Slack user by email address",
    timeoutSeconds: 30,
    capabilities: ["idempotent", "supportsRetry"],
    credentialType: "slack.bot",
    credentialSchema: SLACK_CREDENTIAL as never,
    inputSchema: {
      type: "object",
      required: ["email"],
      properties: { email: { type: "string", minLength: 3 } },
      additionalProperties: true,
    } as never,
    outputSchema: {
      type: "object",
      required: ["user"],
      properties: { user: { type: "object" } },
      additionalProperties: true,
    } as never,
    handler: async (request): Promise<ActionResult> => {
      const body = await slackCall(request, "users.lookupByEmail", { email: request.input.email });
      const user = (body.user ?? {}) as Record<string, unknown>;
      return {
        output: {
          user: {
            id: user.id ?? null,
            name: user.name ?? null,
            realName: user.real_name ?? null,
            email: (user.profile as Record<string, unknown> | undefined)?.email ?? null,
            isBot: user.is_bot ?? false,
          },
        },
      };
    },
  },
];
