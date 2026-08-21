/**
 * JSON Schema validation for action input, output and credential payloads.
 *
 * Implements the draft-07 subset the action catalog actually uses. It is
 * written by hand rather than pulled from a library because the mainstream
 * validators compile schemas into JavaScript with `new Function`, which
 * Workers refuse to run.
 */

export interface SchemaIssue {
  path: string;
  message: string;
}

export class SchemaValidationError extends Error {
  readonly issues: SchemaIssue[];
  constructor(subject: string, issues: SchemaIssue[]) {
    super(
      `${subject} failed schema validation:\n` +
        issues.map((i) => `  ${i.path || "(root)"}: ${i.message}`).join("\n"),
    );
    this.name = "SchemaValidationError";
    this.issues = issues;
  }
}

export type JsonSchema = Record<string, unknown>;

export function validate(schema: JsonSchema | undefined, value: unknown, subject: string): void {
  if (!schema) return;
  const issues: SchemaIssue[] = [];
  check(schema, value, "", issues);
  if (issues.length > 0) throw new SchemaValidationError(subject, issues);
}

export function isValid(schema: JsonSchema | undefined, value: unknown): boolean {
  if (!schema) return true;
  const issues: SchemaIssue[] = [];
  check(schema, value, "", issues);
  return issues.length === 0;
}

function check(schema: JsonSchema, value: unknown, path: string, issues: SchemaIssue[]): void {
  if (typeof schema === "boolean") {
    if (!schema) issues.push({ path, message: "is not allowed here" });
    return;
  }

  // Composition keywords.
  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf as JsonSchema[]) check(sub, value, path, issues);
  }
  if (Array.isArray(schema.anyOf)) {
    const matched = (schema.anyOf as JsonSchema[]).some((sub) => isValid(sub, value));
    if (!matched) issues.push({ path, message: "does not match any permitted schema" });
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = (schema.oneOf as JsonSchema[]).filter((sub) => isValid(sub, value)).length;
    if (matches !== 1) {
      issues.push({ path, message: `must match exactly one permitted schema (matched ${matches})` });
    }
  }
  if (schema.not && isValid(schema.not as JsonSchema, value)) {
    issues.push({ path, message: "matches an excluded schema" });
  }

  if (schema.const !== undefined && !deepEqual(value, schema.const)) {
    issues.push({ path, message: `must equal ${JSON.stringify(schema.const)}` });
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => deepEqual(value, option))) {
    issues.push({ path, message: `must be one of ${JSON.stringify(schema.enum)}` });
  }

  if (schema.type !== undefined && !matchesType(schema.type, value)) {
    issues.push({
      path,
      message: `must be of type ${JSON.stringify(schema.type)}, got ${describe(value)}`,
    });
    // Type is wrong, so keyword checks below would only add noise.
    return;
  }

  if (typeof value === "string") checkString(schema, value, path, issues);
  if (typeof value === "number") checkNumber(schema, value, path, issues);
  if (Array.isArray(value)) checkArray(schema, value, path, issues);
  else if (value !== null && typeof value === "object") {
    checkObject(schema, value as Record<string, unknown>, path, issues);
  }
}

function checkString(schema: JsonSchema, value: string, path: string, issues: SchemaIssue[]): void {
  if (typeof schema.minLength === "number" && value.length < schema.minLength) {
    issues.push({ path, message: `must be at least ${schema.minLength} characters` });
  }
  if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
    issues.push({ path, message: `must be at most ${schema.maxLength} characters` });
  }
  if (typeof schema.pattern === "string") {
    let re: RegExp | null = null;
    try {
      re = new RegExp(schema.pattern);
    } catch {
      issues.push({ path, message: `schema pattern ${schema.pattern} is not a valid regex` });
    }
    if (re && !re.test(value)) {
      issues.push({ path, message: `must match ${schema.pattern}` });
    }
  }
}

function checkNumber(schema: JsonSchema, value: number, path: string, issues: SchemaIssue[]): void {
  if (typeof schema.minimum === "number" && value < schema.minimum) {
    issues.push({ path, message: `must be >= ${schema.minimum}` });
  }
  if (typeof schema.maximum === "number" && value > schema.maximum) {
    issues.push({ path, message: `must be <= ${schema.maximum}` });
  }
  if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) {
    issues.push({ path, message: `must be > ${schema.exclusiveMinimum}` });
  }
  if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) {
    issues.push({ path, message: `must be < ${schema.exclusiveMaximum}` });
  }
  if (typeof schema.multipleOf === "number" && schema.multipleOf > 0) {
    const quotient = value / schema.multipleOf;
    if (Math.abs(quotient - Math.round(quotient)) > 1e-9) {
      issues.push({ path, message: `must be a multiple of ${schema.multipleOf}` });
    }
  }
}

function checkArray(schema: JsonSchema, value: unknown[], path: string, issues: SchemaIssue[]): void {
  if (typeof schema.minItems === "number" && value.length < schema.minItems) {
    issues.push({ path, message: `must have at least ${schema.minItems} items` });
  }
  if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
    issues.push({ path, message: `must have at most ${schema.maxItems} items` });
  }
  if (schema.uniqueItems === true) {
    const seen = new Set(value.map((item) => JSON.stringify(item)));
    if (seen.size !== value.length) issues.push({ path, message: "must not contain duplicates" });
  }
  if (schema.items) {
    if (Array.isArray(schema.items)) {
      (schema.items as JsonSchema[]).forEach((sub, index) => {
        if (index < value.length) check(sub, value[index], `${path}[${index}]`, issues);
      });
    } else {
      value.forEach((item, index) => {
        check(schema.items as JsonSchema, item, `${path}[${index}]`, issues);
      });
    }
  }
}

function checkObject(
  schema: JsonSchema,
  value: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[],
): void {
  const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;

  if (Array.isArray(schema.required)) {
    for (const key of schema.required as string[]) {
      if (!(key in value) || value[key] === undefined) {
        issues.push({ path: join(path, key), message: "is required" });
      }
    }
  }

  for (const [key, item] of Object.entries(value)) {
    const propertySchema = properties[key];
    if (propertySchema) {
      check(propertySchema, item, join(path, key), issues);
      continue;
    }

    let matchedPattern = false;
    const patternProperties = (schema.patternProperties ?? {}) as Record<string, JsonSchema>;
    for (const [pattern, sub] of Object.entries(patternProperties)) {
      try {
        if (new RegExp(pattern).test(key)) {
          matchedPattern = true;
          check(sub, item, join(path, key), issues);
        }
      } catch {
        // An invalid pattern in the catalog is a catalog bug; ignore the rule.
      }
    }
    if (matchedPattern) continue;

    if (schema.additionalProperties === false) {
      issues.push({ path: join(path, key), message: "is not a permitted property" });
    } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
      check(schema.additionalProperties as JsonSchema, item, join(path, key), issues);
    }
  }

  if (typeof schema.minProperties === "number" && Object.keys(value).length < schema.minProperties) {
    issues.push({ path, message: `must have at least ${schema.minProperties} properties` });
  }
  if (typeof schema.maxProperties === "number" && Object.keys(value).length > schema.maxProperties) {
    issues.push({ path, message: `must have at most ${schema.maxProperties} properties` });
  }
}

function matchesType(type: unknown, value: unknown): boolean {
  const types = Array.isArray(type) ? type : [type];
  return types.some((candidate) => {
    switch (candidate) {
      case "string": return typeof value === "string";
      case "number": return typeof value === "number" && Number.isFinite(value);
      case "integer": return typeof value === "number" && Number.isInteger(value);
      case "boolean": return typeof value === "boolean";
      case "null": return value === null;
      case "array": return Array.isArray(value);
      case "object": return value !== null && typeof value === "object" && !Array.isArray(value);
      default: return true;
    }
  });
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function join(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const keys = Object.keys(left);
    return (
      keys.length === Object.keys(right).length &&
      keys.every((key) => deepEqual(left[key], right[key]))
    );
  }
  return false;
}
