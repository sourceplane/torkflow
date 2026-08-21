import type { BundleReader } from "../expression/resolve.js";
import type { JsonSchema } from "../schema/validate.js";

/**
 * The action contract.
 *
 * The CLI's actions are separate OS processes that speak JSON over stdin and
 * stdout (`internal/executor/binary.go`). Workers have no process model, so an
 * action here is a TypeScript function — but the *descriptor* is the same one
 * the CLI's `actionModule.yaml` declares (input/output/credential schemas,
 * timeout, capabilities), and the request and result carry the same fields the
 * binary protocol did. Only the transport changed.
 */

export interface ActionRequest {
  actionRef: string;
  stepName: string;
  input: Record<string, unknown>;
  /** Resolved credential payload, injected by the platform. */
  credential: Record<string, unknown>;
  metadata: ActionMetadata;
  /** Read-only view of the run context, for actions that evaluate expressions. */
  context: Record<string, unknown>;
  /** The workflow's bundle, for actions that load files. */
  bundle?: BundleReader;
  /** Aborts when the step's timeout elapses. */
  signal: AbortSignal;
  /** Per-run services an action may use, set by the runner. */
  services: ActionServices;
}

export interface ActionMetadata {
  workflowId: string;
  executionId: string;
  runId: string;
  tenantId: string;
  attempt: number;
}

export interface ActionServices {
  /** Workers AI binding, when the deployment has one. */
  ai?: unknown;
  /** Appends a line to the run log — where `core.stdout` output goes. */
  log(line: string): void;
}

export interface ActionResult {
  output: Record<string, unknown>;
  /**
   * The branch this step took. Outbound edges naming a different branch are
   * not followed. `core.if` returns "true"/"false".
   */
  branch?: string;
}

export type ActionHandler = (request: ActionRequest) => Promise<ActionResult> | ActionResult;

export interface ActionDescriptor {
  /** Fully-qualified reference used by `actionRef` in a workflow step. */
  name: string;
  /** Owning module, e.g. "http", "core", "ai". */
  module: string;
  version: string;
  description: string;
  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;
  /** Connection type this action requires; empty means none. */
  credentialType?: string;
  credentialSchema?: JsonSchema;
  /** Default timeout in seconds, overridable per step. */
  timeoutSeconds: number;
  capabilities?: string[];
  handler: ActionHandler;
  /**
   * Actions the driver implements itself rather than invoking — `core.sleep`
   * becomes `step.sleep`, `core.approval` becomes `step.waitForEvent`. The
   * descriptor still carries schemas so the catalog and the builder can show
   * them.
   */
  driverHandled?: "sleep" | "approval";
}

/** An action failure the platform must not retry — bad input, not bad luck. */
export class NonRetryableActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableActionError";
  }
}

/** An action failure that is worth retrying — a timeout, a 503, a reset. */
export class RetryableActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableActionError";
  }
}
