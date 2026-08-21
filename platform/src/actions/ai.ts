import {
  NonRetryableActionError,
  RetryableActionError,
  type ActionDescriptor,
  type ActionRequest,
  type ActionResult,
} from "./types.js";

/**
 * AI actions.
 *
 * Every provider returns the same unified output shape the CLI's AI module
 * declares — `text`, `toolCalls`, `usage`, `providerMetadata` — so a workflow
 * can switch providers without downstream steps changing.
 *
 * The CLI's `ai.bedrock.chat` is not carried over: it needs SigV4 request
 * signing against a long-lived AWS key pair, which is the wrong credential to
 * hold in a multi-tenant platform. `ai.workersai.chat` runs on the platform's
 * own inference binding instead, and Bedrock-hosted models remain reachable
 * through `http.request.auth` against a gateway.
 */

interface ChatMessage {
  role: string;
  content: string;
}

interface UnifiedUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

const MESSAGES_SCHEMA = {
  type: "array",
  minItems: 1,
  items: {
    type: "object",
    required: ["role", "content"],
    properties: {
      role: { type: "string", minLength: 1 },
      content: { type: "string" },
    },
    additionalProperties: true,
  },
} as const;

const CHAT_OUTPUT_SCHEMA = {
  type: "object",
  required: ["text"],
  properties: {
    text: { type: "string" },
    toolCalls: { type: "array" },
    usage: {
      type: "object",
      properties: {
        promptTokens: { type: "number" },
        completionTokens: { type: "number" },
        totalTokens: { type: "number" },
      },
      additionalProperties: true,
    },
    providerMetadata: { type: "object" },
  },
  additionalProperties: true,
} as const;

function readMessages(request: ActionRequest): ChatMessage[] {
  const raw = request.input.messages;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new NonRetryableActionError(`${request.actionRef} requires a non-empty messages list`);
  }
  return raw.map((message) => {
    const record = message as Record<string, unknown>;
    return { role: String(record.role ?? "user"), content: String(record.content ?? "") };
  });
}

async function callProvider(
  request: ActionRequest,
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: request.signal,
    });
  } catch (error) {
    throw new RetryableActionError(
      `${request.actionRef}: request failed: ${(error as Error).message}`,
    );
  }

  const text = await response.text();
  if (!response.ok) {
    const detail = text.length > 400 ? `${text.slice(0, 397)}...` : text;
    const message = `${request.actionRef}: provider returned ${response.status}: ${detail}`;
    // 429 and 5xx are worth another attempt; a 400 means the request is wrong.
    throw response.status === 429 || response.status >= 500
      ? new RetryableActionError(message)
      : new NonRetryableActionError(message);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new RetryableActionError(`${request.actionRef}: provider returned malformed JSON`);
  }
}

function usage(prompt: unknown, completion: unknown): UnifiedUsage {
  const promptTokens = Number(prompt ?? 0) || 0;
  const completionTokens = Number(completion ?? 0) || 0;
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}

async function openaiChat(request: ActionRequest): Promise<ActionResult> {
  const credential = request.credential as { apiKey?: string; baseUrl?: string };
  if (!credential.apiKey) throw new NonRetryableActionError("ai.openai.chat requires an apiKey");

  const base = credential.baseUrl ?? "https://api.openai.com/v1";
  const body: Record<string, unknown> = {
    model: request.input.model ?? "gpt-4o-mini",
    messages: readMessages(request),
  };
  if (request.input.temperature !== undefined) body.temperature = request.input.temperature;
  if (request.input.maxTokens !== undefined) body.max_tokens = request.input.maxTokens;
  if (request.input.tools !== undefined) body.tools = request.input.tools;
  if (request.input.responseFormat !== undefined) body.response_format = request.input.responseFormat;

  const response = (await callProvider(
    request,
    `${base}/chat/completions`,
    { Authorization: `Bearer ${credential.apiKey}` },
    body,
  )) as {
    choices?: { message?: { content?: string; tool_calls?: unknown[] } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    model?: string;
    id?: string;
  };

  const message = response.choices?.[0]?.message;
  return {
    output: {
      text: message?.content ?? "",
      toolCalls: message?.tool_calls ?? [],
      usage: usage(response.usage?.prompt_tokens, response.usage?.completion_tokens),
      providerMetadata: {
        provider: "openai",
        model: response.model ?? body.model,
        responseId: response.id ?? null,
        rawResponse: { provider: "openai", model: response.model ?? body.model },
      },
    },
  };
}

async function anthropicChat(request: ActionRequest): Promise<ActionResult> {
  const credential = request.credential as {
    apiKey?: string;
    baseUrl?: string;
    version?: string;
  };
  if (!credential.apiKey) throw new NonRetryableActionError("ai.anthropic.chat requires an apiKey");

  const base = credential.baseUrl ?? "https://api.anthropic.com/v1";
  const messages = readMessages(request);
  // Anthropic takes the system prompt as a top-level field, not a message.
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const conversation = messages.filter((m) => m.role !== "system");

  const body: Record<string, unknown> = {
    model: request.input.model ?? "claude-sonnet-4-5",
    max_tokens: request.input.maxTokens ?? 1024,
    messages: conversation,
  };
  if (system !== "") body.system = system;
  if (request.input.temperature !== undefined) body.temperature = request.input.temperature;
  if (request.input.tools !== undefined) body.tools = request.input.tools;

  const response = (await callProvider(
    request,
    `${base}/messages`,
    {
      "x-api-key": credential.apiKey,
      "anthropic-version": credential.version ?? "2023-06-01",
    },
    body,
  )) as {
    content?: { type?: string; text?: string }[];
    usage?: { input_tokens?: number; output_tokens?: number };
    model?: string;
    id?: string;
    stop_reason?: string;
  };

  const text = (response.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
  const toolCalls = (response.content ?? []).filter((block) => block.type === "tool_use");

  return {
    output: {
      text,
      toolCalls,
      usage: usage(response.usage?.input_tokens, response.usage?.output_tokens),
      providerMetadata: {
        provider: "anthropic",
        model: response.model ?? body.model,
        responseId: response.id ?? null,
        stopReason: response.stop_reason ?? null,
        rawResponse: { provider: "anthropic", model: response.model ?? body.model },
      },
    },
  };
}

async function geminiChat(request: ActionRequest): Promise<ActionResult> {
  const credential = request.credential as { apiKey?: string; baseUrl?: string };
  if (!credential.apiKey) throw new NonRetryableActionError("ai.gemini.chat requires an apiKey");

  const base = credential.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
  const model = String(request.input.model ?? "gemini-2.5-flash");
  const messages = readMessages(request);

  const systemText = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" || m.role === "model" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

  const body: Record<string, unknown> = { contents };
  if (systemText !== "") body.systemInstruction = { parts: [{ text: systemText }] };
  if (request.input.generationConfig !== undefined) {
    body.generationConfig = request.input.generationConfig;
  }

  const response = (await callProvider(
    request,
    `${base}/models/${encodeURIComponent(model)}:generateContent`,
    { "x-goog-api-key": credential.apiKey },
    body,
  )) as {
    candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    modelVersion?: string;
  };

  const text = (response.candidates?.[0]?.content?.parts ?? [])
    .map((part) => part.text ?? "")
    .join("");

  return {
    output: {
      text,
      toolCalls: [],
      usage: usage(
        response.usageMetadata?.promptTokenCount,
        response.usageMetadata?.candidatesTokenCount,
      ),
      providerMetadata: {
        provider: "gemini",
        model: response.modelVersion ?? model,
        finishReason: response.candidates?.[0]?.finishReason ?? null,
        rawResponse: { provider: "gemini", model: response.modelVersion ?? model },
      },
    },
  };
}

/** Runs on the platform's own inference binding — no tenant credential needed. */
async function workersAiChat(request: ActionRequest): Promise<ActionResult> {
  const ai = request.services.ai as
    | { run(model: string, input: unknown): Promise<unknown> }
    | undefined;
  if (!ai) {
    throw new NonRetryableActionError(
      "ai.workersai.chat requires the AI binding, which this deployment does not have",
    );
  }

  const model = String(request.input.model ?? "@cf/meta/llama-3.1-8b-instruct");
  const response = (await ai.run(model, {
    messages: readMessages(request),
    ...(request.input.maxTokens !== undefined ? { max_tokens: request.input.maxTokens } : {}),
    ...(request.input.temperature !== undefined ? { temperature: request.input.temperature } : {}),
  })) as { response?: string; usage?: { prompt_tokens?: number; completion_tokens?: number } };

  return {
    output: {
      text: response.response ?? "",
      toolCalls: [],
      usage: usage(response.usage?.prompt_tokens, response.usage?.completion_tokens),
      providerMetadata: {
        provider: "workers-ai",
        model,
        rawResponse: { provider: "workers-ai", model },
      },
    },
  };
}

function chatDescriptor(
  name: string,
  description: string,
  credentialType: string | undefined,
  handler: (request: ActionRequest) => Promise<ActionResult>,
  extraInput: Record<string, unknown> = {},
): ActionDescriptor {
  return {
    name,
    module: "ai",
    version: "1.0.0",
    description,
    timeoutSeconds: 120,
    capabilities: ["supportsRetry"],
    ...(credentialType ? { credentialType } : {}),
    ...(credentialType
      ? {
          credentialSchema: {
            type: "object",
            required: ["apiKey"],
            properties: { apiKey: { type: "string", minLength: 1 }, baseUrl: { type: "string" } },
            additionalProperties: true,
          } as never,
        }
      : {}),
    inputSchema: {
      type: "object",
      required: ["messages"],
      properties: {
        model: { type: "string" },
        messages: MESSAGES_SCHEMA,
        temperature: { type: "number" },
        maxTokens: { type: "number", minimum: 1 },
        tools: { type: "array" },
        ...extraInput,
      },
      additionalProperties: true,
    } as never,
    outputSchema: CHAT_OUTPUT_SCHEMA as never,
    handler,
  };
}

export const aiActions: ActionDescriptor[] = [
  chatDescriptor("ai.openai.chat", "Chat completion via OpenAI", "ai.openai", openaiChat, {
    responseFormat: { type: "object" },
  }),
  chatDescriptor("ai.anthropic.chat", "Chat completion via Anthropic", "ai.anthropic", anthropicChat),
  chatDescriptor("ai.gemini.chat", "Chat completion via Google Gemini", "ai.gemini", geminiChat, {
    generationConfig: { type: "object" },
  }),
  chatDescriptor(
    "ai.workersai.chat",
    "Chat completion on the platform's own Workers AI inference",
    undefined,
    workersAiChat,
  ),
];
