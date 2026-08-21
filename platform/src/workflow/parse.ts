import { parse as parseYaml } from "yaml";
import {
  API_VERSION,
  KIND,
  effectiveActionRef,
  type OutboundEdge,
  type Step,
  type Workflow,
} from "./types.js";

/** A validation problem, addressed to the person who wrote the YAML. */
export interface WorkflowIssue {
  path: string;
  message: string;
}

export class WorkflowParseError extends Error {
  readonly issues: WorkflowIssue[];
  constructor(issues: WorkflowIssue[]) {
    super(
      `workflow is invalid:\n` +
        issues.map((i) => `  ${i.path}: ${i.message}`).join("\n"),
    );
    this.name = "WorkflowParseError";
    this.issues = issues;
  }
}

const CRON_FIELDS = 5;

/**
 * Parse and validate a `torkflow/v1` document.
 *
 * Validation is stricter than the CLI's on purpose: the CLI fails at the step
 * that turns out to be broken, halfway through a run, whereas the platform
 * rejects the workflow at publish time. Everything checked here is checkable
 * from the file alone — action existence is checked separately against the
 * registry, because the catalog is deployment state, not file content.
 */
export function parseWorkflow(source: string): Workflow {
  let doc: unknown;
  try {
    doc = parseYaml(source);
  } catch (err) {
    throw new WorkflowParseError([
      { path: "(document)", message: `YAML is malformed: ${(err as Error).message}` },
    ]);
  }
  return validateWorkflow(doc);
}

export function validateWorkflow(doc: unknown): Workflow {
  const issues: WorkflowIssue[] = [];

  if (!isRecord(doc)) {
    throw new WorkflowParseError([
      { path: "(document)", message: "expected a mapping at the document root" },
    ]);
  }

  if (doc.apiVersion !== API_VERSION) {
    issues.push({
      path: "apiVersion",
      message: `expected ${JSON.stringify(API_VERSION)}, got ${JSON.stringify(doc.apiVersion ?? null)}`,
    });
  }
  if (doc.kind !== KIND) {
    issues.push({
      path: "kind",
      message: `expected ${JSON.stringify(KIND)}, got ${JSON.stringify(doc.kind ?? null)}`,
    });
  }

  const metadata = isRecord(doc.metadata) ? doc.metadata : {};
  if (typeof metadata.name !== "string" || metadata.name.trim() === "") {
    issues.push({ path: "metadata.name", message: "is required and must be a non-empty string" });
  }

  const spec = isRecord(doc.spec) ? doc.spec : undefined;
  if (!spec) {
    issues.push({ path: "spec", message: "is required and must be a mapping" });
    throw new WorkflowParseError(issues);
  }

  const rawSteps = spec.steps;
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    issues.push({ path: "spec.steps", message: "is required and must be a non-empty list" });
    throw new WorkflowParseError(issues);
  }

  const steps: Step[] = [];
  const seen = new Set<string>();
  rawSteps.forEach((raw, index) => {
    const at = `spec.steps[${index}]`;
    if (!isRecord(raw)) {
      issues.push({ path: at, message: "must be a mapping" });
      return;
    }
    const name = raw.name;
    if (typeof name !== "string" || name.trim() === "") {
      issues.push({ path: `${at}.name`, message: "is required and must be a non-empty string" });
      return;
    }
    if (seen.has(name)) {
      issues.push({ path: `${at}.name`, message: `duplicate step name ${JSON.stringify(name)}` });
      return;
    }
    seen.add(name);

    const step = raw as unknown as Step;
    if (effectiveActionRef(step) === "") {
      issues.push({ path: `${at}.actionRef`, message: "is required (or provide actionId)" });
    }

    const gate = step.readinessGate?.thresholdType;
    if (gate !== undefined && gate !== "ALL" && gate !== "ANY") {
      issues.push({
        path: `${at}.readinessGate.thresholdType`,
        message: `must be "ALL" or "ANY", got ${JSON.stringify(gate)}`,
      });
    }

    if (step.timeoutSeconds !== undefined && !isPositiveNumber(step.timeoutSeconds)) {
      issues.push({ path: `${at}.timeoutSeconds`, message: "must be a positive number" });
    }

    const retry = step.retry ?? step.errorHandlers?.[0]?.retryStrategy;
    if (retry) {
      if (retry.maxRetries !== undefined && !isNonNegativeInteger(retry.maxRetries)) {
        issues.push({ path: `${at}.retry.maxRetries`, message: "must be a non-negative integer" });
      }
      if (retry.baseDelaySeconds !== undefined && !isNonNegativeNumber(retry.baseDelaySeconds)) {
        issues.push({ path: `${at}.retry.baseDelaySeconds`, message: "must be a non-negative number" });
      }
    }

    const edges = step.outboundEdges;
    if (edges !== undefined) {
      if (!Array.isArray(edges)) {
        issues.push({ path: `${at}.outboundEdges`, message: "must be a list" });
      } else {
        edges.forEach((edge: OutboundEdge, ei: number) => {
          if (!isRecord(edge) || typeof edge.nextStepName !== "string" || edge.nextStepName === "") {
            issues.push({
              path: `${at}.outboundEdges[${ei}].nextStepName`,
              message: "is required and must be a non-empty string",
            });
          }
        });
      }
    }

    steps.push(step);
  });

  const names = new Set(steps.map((s) => s.name));

  // Dangling references are the most common authoring mistake and the CLI only
  // surfaces them as a silently-dropped edge (`_ = graph.AddEdge(...)`).
  for (const step of steps) {
    for (const [ei, edge] of (step.outboundEdges ?? []).entries()) {
      if (edge?.nextStepName && !names.has(edge.nextStepName)) {
        issues.push({
          path: `spec.steps[${step.name}].outboundEdges[${ei}].nextStepName`,
          message: `references unknown step ${JSON.stringify(edge.nextStepName)}`,
        });
      }
    }
    if (step.fallbackStepName && !names.has(step.fallbackStepName)) {
      issues.push({
        path: `spec.steps[${step.name}].fallbackStepName`,
        message: `references unknown step ${JSON.stringify(step.fallbackStepName)}`,
      });
    }
  }

  if (spec.maxParallelSteps !== undefined && !isPositiveNumber(spec.maxParallelSteps)) {
    issues.push({ path: "spec.maxParallelSteps", message: "must be a positive number" });
  }

  if (spec.outputs !== undefined) {
    if (!isRecord(spec.outputs)) {
      issues.push({ path: "spec.outputs", message: "must be a mapping of name to expression" });
    } else {
      for (const [key, value] of Object.entries(spec.outputs)) {
        if (typeof value !== "string") {
          issues.push({ path: `spec.outputs.${key}`, message: "must be a string expression" });
        }
      }
    }
  }

  if (spec.triggers !== undefined) {
    if (!Array.isArray(spec.triggers)) {
      issues.push({ path: "spec.triggers", message: "must be a list" });
    } else {
      spec.triggers.forEach((trigger: unknown, index: number) => {
        const at = `spec.triggers[${index}]`;
        if (!isRecord(trigger)) {
          issues.push({ path: at, message: "must be a mapping" });
          return;
        }
        switch (trigger.type) {
          case "schedule": {
            const cron = trigger.cron;
            if (typeof cron !== "string" || cron.trim().split(/\s+/).length !== CRON_FIELDS) {
              issues.push({
                path: `${at}.cron`,
                message: "is required and must be a 5-field cron expression",
              });
            }
            break;
          }
          case "webhook":
          case "manual":
            break;
          default:
            issues.push({
              path: `${at}.type`,
              message: `must be one of "schedule", "webhook", "manual"; got ${JSON.stringify(trigger.type ?? null)}`,
            });
        }
      });
    }
  }

  // A cycle would make the scheduler wait forever on an inbound edge that can
  // never be satisfied. The CLI discovers this as a hang; catch it here.
  const cycle = findCycle(steps);
  if (cycle) {
    issues.push({
      path: "spec.steps",
      message: `graph contains a cycle: ${cycle.join(" -> ")}`,
    });
  }

  if (issues.length > 0) throw new WorkflowParseError(issues);

  return {
    apiVersion: API_VERSION,
    kind: KIND,
    metadata: metadata as unknown as Workflow["metadata"],
    spec: { ...spec, steps } as unknown as Workflow["spec"],
  };
}

/** Returns a cycle as a list of step names, or null when the graph is acyclic. */
function findCycle(steps: Step[]): string[] | null {
  const adjacency = new Map<string, string[]>();
  for (const step of steps) {
    adjacency.set(
      step.name,
      (step.outboundEdges ?? []).map((e) => e.nextStepName).filter((n) => typeof n === "string"),
    );
  }

  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const colour = new Map<string, number>();
  for (const step of steps) colour.set(step.name, WHITE);

  const stack: string[] = [];

  const visit = (node: string): string[] | null => {
    colour.set(node, GREY);
    stack.push(node);
    for (const next of adjacency.get(node) ?? []) {
      if (!colour.has(next)) continue;
      const state = colour.get(next);
      if (state === GREY) {
        const start = stack.indexOf(next);
        return [...stack.slice(start), next];
      }
      if (state === WHITE) {
        const found = visit(next);
        if (found) return found;
      }
    }
    stack.pop();
    colour.set(node, BLACK);
    return null;
  };

  // Sorted so the reported cycle is stable across runs.
  for (const name of [...adjacency.keys()].sort()) {
    if (colour.get(name) === WHITE) {
      const found = visit(name);
      if (found) return found;
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNonNegativeNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
