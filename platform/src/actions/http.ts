import {
  NonRetryableActionError,
  RetryableActionError,
  type ActionDescriptor,
  type ActionRequest,
  type ActionResult,
} from "./types.js";

/**
 * HTTP actions.
 *
 * The input and output schemas are the ones declared in the CLI's
 * `actionStore/http/actionModule.yaml`, so a step written for the CLI's
 * `http.request` keeps working — same parameters, same `{statusCode, headers,
 * body, json}` output shape.
 */

const REQUEST_INPUT_SCHEMA = {
  type: "object",
  required: ["url"],
  properties: {
    url: { type: "string", minLength: 1 },
    method: { type: "string" },
    headers: { type: "object", additionalProperties: { type: ["string", "number", "boolean"] } },
    body: {},
    timeoutSeconds: { type: "number", minimum: 1 },
    parseJson: { type: "boolean" },
    /** Treat a non-2xx response as a step failure. Default true. */
    failOnError: { type: "boolean" },
  },
  additionalProperties: true,
} as const;

const REQUEST_OUTPUT_SCHEMA = {
  type: "object",
  required: ["statusCode", "body"],
  properties: {
    statusCode: { type: "number" },
    headers: { type: "object" },
    body: { type: "string" },
    json: {},
    ok: { type: "boolean" },
  },
  additionalProperties: true,
} as const;

/**
 * Status codes worth retrying. A 4xx means the request was wrong and will stay
 * wrong, so it fails without burning the step's retry budget.
 */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function performRequest(
  request: ActionRequest,
  extraHeaders: Record<string, string>,
): Promise<ActionResult> {
  const input = request.input;
  const url = String(input.url);

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new NonRetryableActionError(`http: ${JSON.stringify(url)} is not a valid URL`);
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new NonRetryableActionError(
      `http: unsupported protocol ${parsedUrl.protocol} — only http and https are allowed`,
    );
  }

  const method = typeof input.method === "string" && input.method !== ""
    ? input.method.toUpperCase()
    : "GET";

  const headers = new Headers();
  for (const [key, value] of Object.entries(extraHeaders)) headers.set(key, value);
  for (const [key, value] of Object.entries(
    (input.headers ?? {}) as Record<string, unknown>,
  )) {
    headers.set(key, String(value));
  }

  let body: string | undefined;
  if (input.body !== undefined && input.body !== null && method !== "GET" && method !== "HEAD") {
    if (typeof input.body === "string") {
      body = input.body;
    } else {
      body = JSON.stringify(input.body);
      if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    }
  }

  // The step's own timeout still bounds this; a per-request timeout lets a
  // single slow call fail without taking the whole step's budget.
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal.addEventListener("abort", abort, { once: true });
  const timeoutSeconds = typeof input.timeoutSeconds === "number" ? input.timeoutSeconds : 0;
  const timer =
    timeoutSeconds > 0 ? setTimeout(() => controller.abort(), timeoutSeconds * 1000) : undefined;

  let response: Response;
  try {
    response = await fetch(parsedUrl.toString(), {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal: controller.signal,
      redirect: "follow",
    });
  } catch (error) {
    const message = (error as Error).message ?? String(error);
    if (controller.signal.aborted) {
      throw new RetryableActionError(`http: request to ${parsedUrl.host} timed out`);
    }
    // A transport failure is transient far more often than not.
    throw new RetryableActionError(`http: request to ${parsedUrl.host} failed: ${message}`);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    request.signal.removeEventListener("abort", abort);
  }

  const text = await response.text();
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });

  const output: Record<string, unknown> = {
    statusCode: response.status,
    headers: responseHeaders,
    body: text,
    ok: response.ok,
  };

  // `parseJson` mirrors the CLI's flag; a JSON content-type is also honoured so
  // downstream `{{ Steps.X.json.field }}` works without opting in every time.
  const wantsJson =
    input.parseJson === true ||
    (input.parseJson !== false &&
      (responseHeaders["content-type"] ?? "").includes("application/json"));
  if (wantsJson && text !== "") {
    try {
      output.json = JSON.parse(text);
    } catch {
      if (input.parseJson === true) {
        throw new NonRetryableActionError(
          `http: response from ${parsedUrl.host} is not valid JSON`,
        );
      }
    }
  }

  if (input.failOnError !== false && !response.ok) {
    const detail = text.length > 300 ? `${text.slice(0, 297)}...` : text;
    const message = `http: ${method} ${parsedUrl.host} returned ${response.status}: ${detail}`;
    throw isRetryableStatus(response.status)
      ? new RetryableActionError(message)
      : new NonRetryableActionError(message);
  }

  return { output };
}

export const httpActions: ActionDescriptor[] = [
  {
    name: "http.request",
    module: "http",
    version: "1.0.0",
    description: "Execute an outbound HTTP request",
    timeoutSeconds: 30,
    capabilities: ["idempotent", "supportsRetry"],
    inputSchema: REQUEST_INPUT_SCHEMA as never,
    outputSchema: REQUEST_OUTPUT_SCHEMA as never,
    handler: (request) => performRequest(request, {}),
  },
  {
    name: "http.request.auth",
    module: "http",
    version: "1.0.0",
    description: "Execute an outbound HTTP request with a bearer credential injected",
    timeoutSeconds: 30,
    capabilities: ["idempotent", "supportsRetry"],
    credentialType: "http.bearer",
    credentialSchema: {
      type: "object",
      required: ["bearerToken"],
      properties: {
        bearerToken: { type: "string", minLength: 1 },
        headers: { type: "object", additionalProperties: { type: ["string", "number", "boolean"] } },
      },
      additionalProperties: true,
    } as never,
    inputSchema: REQUEST_INPUT_SCHEMA as never,
    outputSchema: REQUEST_OUTPUT_SCHEMA as never,
    handler: (request) => {
      const credential = request.credential as {
        bearerToken?: string;
        headers?: Record<string, unknown>;
      };
      const headers: Record<string, string> = {
        Authorization: `Bearer ${credential.bearerToken ?? ""}`,
      };
      for (const [key, value] of Object.entries(credential.headers ?? {})) {
        headers[key] = String(value);
      }
      return performRequest(request, headers);
    },
  },
];
