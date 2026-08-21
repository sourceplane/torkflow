/**
 * The `torkflow/v1` workflow model.
 *
 * This is a faithful TypeScript port of the Go model in
 * `internal/workflow/model.go`, so a workflow file authored for the CLI runs
 * unchanged on the platform. Fields added here for Datadog-style parity
 * (`spec.triggers`, `spec.inputs`) are additive and optional: a file that omits
 * them behaves exactly as it does today.
 */

export const API_VERSION = "torkflow/v1";
export const KIND = "Workflow";

export interface Workflow {
  apiVersion: string;
  kind: string;
  metadata: WorkflowMetadata;
  spec: WorkflowSpec;
}

export interface WorkflowMetadata {
  name: string;
  id?: string;
  description?: string;
  labels?: Record<string, string>;
}

export interface WorkflowSpec {
  steps: Step[];
  maxParallelSteps?: number;
  /**
   * Declared outputs: name → a `{{ }}` expression evaluated against the final
   * run context. Only these cross back to a caller — the raw context never
   * does. Mirrors WX4 in the CLI.
   */
  outputs?: Record<string, string>;
  /** Declared trigger inputs, surfaced in the UI and validated on run start. */
  inputs?: Record<string, InputSpec>;
  /** How runs of this workflow start. Empty means manual/API only. */
  triggers?: Trigger[];
  /** Legacy inline connection payloads (`spec.connections`). */
  connections?: Record<string, unknown>;
}

export interface InputSpec {
  type?: "string" | "number" | "boolean" | "object" | "array";
  description?: string;
  required?: boolean;
  default?: unknown;
  enum?: unknown[];
}

export type Trigger = ScheduleTrigger | WebhookTrigger | ManualTrigger;

export interface ScheduleTrigger {
  type: "schedule";
  name?: string;
  /** 5-field cron, evaluated in `timezone` (default UTC). */
  cron: string;
  timezone?: string;
  with?: Record<string, unknown>;
}

export interface WebhookTrigger {
  type: "webhook";
  name?: string;
  /** Optional HMAC-SHA256 secret name for signature verification. */
  secretRef?: string;
  /** Map the inbound body onto Trigger context; omitted means the whole body. */
  with?: Record<string, unknown>;
}

export interface ManualTrigger {
  type: "manual";
  name?: string;
}

export interface Step {
  name: string;
  /** Action to invoke. `actionId` is accepted as an alias, as in the CLI. */
  actionRef?: string;
  actionId?: string;
  parameters?: Record<string, unknown>;
  /** Named connection whose resolved credential is injected into the action. */
  connection?: string;
  outboundEdges?: OutboundEdge[];
  readinessGate?: ReadinessGate;
  retry?: RetryStrategy;
  errorHandlers?: ErrorHandler[];
  fallbackStepName?: string;
  timeoutSeconds?: number;
  /** `{{ }}`-free JS expression; truthy means the step is skipped. */
  skip?: string;
  /**
   * A failed step with this set does not fail the run and still unlocks its
   * outbound edges. (In the Go CLI this flag is parsed but has no effect; the
   * platform implements the Datadog behaviour it names.)
   */
  continueOnError?: boolean;
}

export interface OutboundEdge {
  nextStepName: string;
  /** When set, the edge is only followed if the step returned this branch. */
  branchName?: string;
}

export interface ReadinessGate {
  /** ALL (default): every inbound edge must be satisfied. ANY: just one. */
  thresholdType?: "ALL" | "ANY";
}

export interface ErrorHandler {
  retryStrategy?: RetryStrategy;
}

export interface RetryStrategy {
  kind?: string;
  maxRetries?: number;
  baseDelaySeconds?: number;
}

/** The effective action reference for a step, honouring the `actionId` alias. */
export function effectiveActionRef(step: Step): string {
  return step.actionRef && step.actionRef !== "" ? step.actionRef : (step.actionId ?? "");
}

/** The workflow's stable id: `metadata.id`, else `metadata.name`. */
export function workflowId(wf: Workflow): string {
  return wf.metadata.id && wf.metadata.id !== "" ? wf.metadata.id : wf.metadata.name;
}

/** The retry strategy in force for a step, honouring the `errorHandlers` alias. */
export function effectiveRetry(step: Step): RetryStrategy | undefined {
  if (step.retry) return step.retry;
  return step.errorHandlers?.[0]?.retryStrategy;
}
