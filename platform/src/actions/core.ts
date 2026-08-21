import { evaluateExpression, runScript } from "../expression/interpreter.js";
import { NonRetryableActionError, type ActionDescriptor, type ActionRequest } from "./types.js";

/**
 * Core actions — the ones the engine itself provides.
 *
 * Behaviour matches `internal/core/actions.go`, including the alias names, the
 * duration forms `core.sleep` accepts and the exact output shapes, so a
 * workflow authored against the CLI produces the same step outputs here.
 */

/** Parses the duration forms `core.sleep` accepts, returning milliseconds. */
export function resolveSleepMilliseconds(input: Record<string, unknown>): number {
  if ("duration" in input) {
    const raw = input.duration;
    if (typeof raw === "string") {
      const parsed = parseGoDuration(raw.trim());
      if (parsed === null) {
        throw new NonRetryableActionError(
          `core.sleep invalid duration ${JSON.stringify(raw)}`,
        );
      }
      if (parsed < 0) throw new NonRetryableActionError("core.sleep duration cannot be negative");
      return parsed;
    }
    const seconds = toNumber(raw);
    if (seconds === null) {
      throw new NonRetryableActionError("core.sleep duration must be string or number");
    }
    if (seconds < 0) throw new NonRetryableActionError("core.sleep duration cannot be negative");
    return seconds * 1000;
  }

  if ("seconds" in input) {
    const seconds = toNumber(input.seconds);
    if (seconds === null) throw new NonRetryableActionError("core.sleep seconds must be a number");
    if (seconds < 0) throw new NonRetryableActionError("core.sleep seconds cannot be negative");
    return seconds * 1000;
  }

  if ("milliseconds" in input) {
    const ms = toNumber(input.milliseconds);
    if (ms === null) throw new NonRetryableActionError("core.sleep milliseconds must be a number");
    if (ms < 0) throw new NonRetryableActionError("core.sleep milliseconds cannot be negative");
    return ms;
  }

  throw new NonRetryableActionError(
    "core.sleep requires one of: duration, seconds, milliseconds",
  );
}

/** Go's `time.ParseDuration` grammar: `1h30m`, `500ms`, `2.5s`, `-1s`. */
export function parseGoDuration(text: string): number | null {
  if (text === "") return null;
  if (text === "0") return 0;

  const unitMs: Record<string, number> = {
    ns: 1e-6,
    us: 1e-3,
    "µs": 1e-3,
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
  };

  let index = 0;
  let sign = 1;
  if (text[0] === "-" || text[0] === "+") {
    sign = text[0] === "-" ? -1 : 1;
    index = 1;
  }
  if (index >= text.length) return null;

  let total = 0;
  let sawComponent = false;

  while (index < text.length) {
    const numberMatch = /^\d*\.?\d*/.exec(text.slice(index));
    const numberText = numberMatch?.[0] ?? "";
    if (numberText === "" || numberText === ".") return null;
    index += numberText.length;

    const unitMatch = /^[a-zµ]+/.exec(text.slice(index));
    const unit = unitMatch?.[0] ?? "";
    if (unit === "" || !(unit in unitMs)) return null;
    index += unit.length;

    total += Number(numberText) * unitMs[unit]!;
    sawComponent = true;
  }

  return sawComponent ? sign * total : null;
}

/** Formats a millisecond count the way Go's `Duration.String()` does. */
export function formatGoDuration(ms: number): string {
  if (ms === 0) return "0s";
  const sign = ms < 0 ? "-" : "";
  let remaining = Math.abs(ms);

  if (remaining < 1) return `${sign}${round(remaining * 1000)}µs`;
  if (remaining < 1000) return `${sign}${round(remaining)}ms`;

  const hours = Math.floor(remaining / 3_600_000);
  remaining -= hours * 3_600_000;
  const minutes = Math.floor(remaining / 60_000);
  remaining -= minutes * 60_000;
  const seconds = remaining / 1000;

  let out = "";
  if (hours > 0) out += `${hours}h`;
  if (hours > 0 || minutes > 0) out += `${minutes}m`;
  out += `${round(seconds)}s`;
  return sign + out;
}

function round(value: number): number {
  return Math.round(value * 1e9) / 1e9;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Renders `core.stdout` payloads, matching the CLI's three formats. */
export function formatOutput(format: string, label: string, payload: unknown): string {
  switch (format) {
    case "json":
      return `[${label}]\n${JSON.stringify(payload, null, 2)}`;
    case "text":
    case "kv":
      return [label, ...flattenKV("", payload)].join("\n");
    case "pretty":
    case "": {
      const body = flattenKV("", payload);
      const lines = body.length > 0 ? body : ["• (empty)"];
      return [
        `╭─ ${label}`,
        ...lines.map((line) => `│ ${line}`),
        "╰────────────────────────────────────────",
      ].join("\n");
    }
    default:
      throw new NonRetryableActionError(`unsupported print format ${JSON.stringify(format)}`);
  }
}

function flattenKV(prefix: string, value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      flattenKV(prefix === "" ? `[${index}]` : `${prefix}[${index}]`, item),
    );
  }
  if (value !== null && typeof value === "object") {
    // Sorted, as the Go implementation sorts its map keys — the rendering must
    // not depend on insertion order.
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .flatMap((key) =>
        flattenKV(prefix === "" ? key : `${prefix}.${key}`, (value as Record<string, unknown>)[key]),
      );
  }
  const key = prefix === "" ? "value" : prefix;
  return [`• ${key}: ${formatScalar(value)}`];
}

function formatScalar(value: unknown): string {
  if (value === null) return "<nil>";
  if (value === undefined) return "<nil>";
  return String(value);
}

async function resolveScript(request: ActionRequest): Promise<string> {
  const inline = typeof request.input.script === "string" ? request.input.script.trim() : "";
  const file =
    typeof request.input.scriptFile === "string"
      ? request.input.scriptFile.trim()
      : typeof request.input.scriptPath === "string"
        ? request.input.scriptPath.trim()
        : "";

  if (inline !== "" && file !== "") {
    throw new NonRetryableActionError("core.js accepts either script or scriptFile, not both");
  }
  if (inline !== "") return inline;

  if (file !== "") {
    if (!request.bundle) {
      throw new NonRetryableActionError(
        `core.js scriptFile ${JSON.stringify(file)} requires a workflow bundle`,
      );
    }
    const content = (await request.bundle.read(file)).trim();
    if (content === "") {
      throw new NonRetryableActionError(`core.js scriptFile ${JSON.stringify(file)} is empty`);
    }
    return content;
  }

  if ("script" in request.input) {
    throw new NonRetryableActionError("core.js script cannot be empty");
  }
  throw new NonRetryableActionError("core.js requires script or scriptFile");
}

export const coreActions: ActionDescriptor[] = [
  {
    name: "core.if",
    module: "core",
    version: "1.0.0",
    description: "Evaluate a condition and branch on the result",
    timeoutSeconds: 30,
    capabilities: ["idempotent", "supportsRetry"],
    inputSchema: {
      type: "object",
      required: ["condition"],
      properties: { condition: { type: "string", minLength: 1 } },
      additionalProperties: true,
    },
    handler: (request) => {
      const condition = request.input.condition;
      if (typeof condition !== "string") {
        throw new NonRetryableActionError("core.if requires string condition");
      }
      const result = evaluateExpression(condition, request.context);
      return { output: { result }, branch: result === true ? "true" : "false" };
    },
  },
  {
    name: "core.js",
    module: "core",
    version: "1.0.0",
    description: "Run a JavaScript expression or script against the run context",
    timeoutSeconds: 30,
    capabilities: ["idempotent", "supportsRetry"],
    handler: async (request) => {
      const script = await resolveScript(request);
      const result = runScript(script, request.context);
      if (result !== null && typeof result === "object" && !Array.isArray(result)) {
        return { output: result as Record<string, unknown> };
      }
      return { output: { result } };
    },
  },
  {
    name: "core.sleep",
    module: "core",
    version: "1.0.0",
    description: "Pause the workflow. Runs as a durable sleep — the instance hibernates.",
    timeoutSeconds: 0,
    driverHandled: "sleep",
    inputSchema: {
      type: "object",
      properties: {
        duration: { type: ["string", "number"] },
        seconds: { type: "number", minimum: 0 },
        milliseconds: { type: "number", minimum: 0 },
      },
      additionalProperties: true,
    },
    handler: () => {
      // Unreachable: the driver turns this into `step.sleep` so the instance
      // hibernates instead of occupying a worker. Kept so the action still has
      // a handler if it is ever invoked directly.
      throw new Error("core.sleep is handled by the workflow driver");
    },
  },
  {
    name: "core.approval",
    module: "core",
    version: "1.0.0",
    description:
      "Pause for a human decision. The run waits durably until approved or rejected.",
    timeoutSeconds: 0,
    driverHandled: "approval",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        /** Who may decide — surfaced in the UI and enforced by the API. */
        approvers: { type: "array", items: { type: "string" } },
        /** How long to wait before the step times out. Default 24h. */
        timeout: { type: "string" },
        /** Branch taken when the deadline passes: "reject" (default) or "approve". */
        onTimeout: { type: "string", enum: ["approve", "reject"] },
      },
      additionalProperties: true,
    },
    handler: () => {
      throw new Error("core.approval is handled by the workflow driver");
    },
  },
  {
    name: "core.noop",
    module: "core",
    version: "1.0.0",
    description: "Do nothing. Useful as an explicit join point in a graph.",
    timeoutSeconds: 5,
    capabilities: ["idempotent", "supportsRetry"],
    handler: (request) => ({ output: { ...request.input } }),
  },
];

// `core.stdout` and its two compatibility aliases share one handler, as in the
// Go registry.
for (const name of ["core.stdout", "core.print", "core.stdPrint"]) {
  coreActions.push({
    name,
    module: "core",
    version: "1.0.0",
    description: "Render a payload into the run log",
    timeoutSeconds: 30,
    capabilities: ["idempotent", "supportsRetry"],
    handler: (request) => {
      const input = request.input;
      let label = "Workflow Output";
      if (typeof input.label === "string" && input.label !== "") label = input.label;
      if (typeof input.title === "string" && input.title !== "") label = input.title;

      let format = "pretty";
      if (typeof input.format === "string" && input.format !== "") {
        format = input.format.toLowerCase();
      }

      let payload: unknown = input;
      if ("payload" in input) {
        const raw = input.payload;
        payload =
          raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : { value: raw };
      }

      const rendered = formatOutput(format, label, payload);
      request.services.log(rendered);

      return { output: { label, format, printed: payload, rendered } };
    },
  });
}
