import { evaluateExpression, ExpressionError } from "./interpreter.js";

const TEMPLATE = /\{\{\s*([\s\S]+?)\s*\}\}/g;

/**
 * Reads a file out of the workflow's content-addressed bundle.
 *
 * `fromFile` in the CLI reads the local filesystem relative to the workflow's
 * directory. There is no filesystem here, so a bundle reader resolves the same
 * relative paths against the published bundle. It is also where the CLI's
 * traversal gap is closed: `internal/engine/scheduler.go`'s `resolveFromFile`
 * accepts absolute paths and does not reject `..`, so on a shared runner
 * `fromFile: /etc/passwd` would read it. Implementations here must confine
 * every path to the bundle root.
 */
export interface BundleReader {
  read(path: string): Promise<string>;
}

export interface ResolveOptions {
  bundle?: BundleReader;
  budget?: number;
}

/**
 * Resolves `{{ }}` in a string.
 *
 * When the string is exactly one template and nothing else, the expression's
 * value is returned with its type intact — `"{{ Steps.A.count }}"` yields the
 * number 4, not the string "4", and an object stays an object. Anything else
 * interpolates into a string.
 *
 * This is a deliberate divergence from the CLI, whose `ResolveString` always
 * formats through `fmt.Sprintf("%v", …)`; that renders a map as Go's
 * `map[k:v]` syntax, which is not valid JSON and cannot be fed to a downstream
 * action. Datadog's resolver preserves types the same way this one does.
 */
export function resolveString(
  input: string,
  context: Record<string, unknown>,
  options: ResolveOptions = {},
): unknown {
  TEMPLATE.lastIndex = 0;
  const matches = [...input.matchAll(TEMPLATE)];
  if (matches.length === 0) return input;

  const only = matches[0]!;
  if (matches.length === 1 && only[0].length === input.length) {
    return evaluateExpression(only[1]!, context, { budget: options.budget });
  }

  let out = "";
  let last = 0;
  for (const match of matches) {
    out += input.slice(last, match.index);
    out += formatInterpolated(evaluateExpression(match[1]!, context, { budget: options.budget }));
    last = match.index + match[0].length;
  }
  return out + input.slice(last);
}

/** Forces a string result — used where the caller needs text regardless. */
export function resolveStringToText(
  input: string,
  context: Record<string, unknown>,
  options: ResolveOptions = {},
): string {
  const value = resolveString(input, context, options);
  return typeof value === "string" ? value : formatInterpolated(value);
}

function formatInterpolated(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "object") return JSON.stringify(value) ?? "";
  return String(value);
}

/**
 * Resolves a step's parameter tree: templates in strings, `fromFile`
 * directives, and recursion through arrays and objects. Mirrors
 * `resolveInput`/`resolveAny` in the Go scheduler.
 */
export async function resolveParameters(
  parameters: Record<string, unknown> | undefined,
  context: Record<string, unknown>,
  options: ResolveOptions = {},
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parameters ?? {})) {
    out[key] = await resolveValue(value, context, options);
  }
  return out;
}

export async function resolveValue(
  value: unknown,
  context: Record<string, unknown>,
  options: ResolveOptions = {},
): Promise<unknown> {
  if (typeof value === "string") return resolveString(value, context, options);

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) out.push(await resolveValue(item, context, options));
    return out;
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length === 1 && keys[0] === "fromFile") {
      return resolveFromFile(record.fromFile, context, options);
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) {
      out[key] = await resolveValue(item, context, options);
    }
    return out;
  }

  return value;
}

async function resolveFromFile(
  source: unknown,
  context: Record<string, unknown>,
  options: ResolveOptions,
): Promise<string> {
  let path = "";
  let template = false;

  if (typeof source === "string") {
    path = source;
  } else if (source && typeof source === "object" && !Array.isArray(source)) {
    for (const key of Object.keys(source)) {
      if (key !== "path" && key !== "template") {
        throw new ExpressionError("fromFile only supports path and template fields");
      }
    }
    const record = source as { path?: unknown; template?: unknown };
    if (record.path !== undefined) {
      if (typeof record.path !== "string") throw new ExpressionError("fromFile.path must be a string");
      path = record.path;
    }
    if (record.template !== undefined) {
      if (typeof record.template !== "boolean") {
        throw new ExpressionError("fromFile.template must be a boolean");
      }
      template = record.template;
    }
  } else {
    throw new ExpressionError("fromFile must be a string path or object");
  }

  if (path.trim() === "") throw new ExpressionError("fromFile.path cannot be empty");
  if (!options.bundle) {
    throw new ExpressionError(`fromFile ${JSON.stringify(path)} requires a workflow bundle`);
  }

  const content = await options.bundle.read(path);
  return template ? resolveStringToText(content, context, options) : content;
}
