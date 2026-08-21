import type { TorkflowRunner } from "./runner.js";
import type { RunParams } from "./runner.js";

export interface Env {
  RUNNER: Workflow<RunParams>;
  DB: D1Database;
  BUNDLES: R2Bucket;
  PAYLOADS: R2Bucket;
  CACHE: KVNamespace;
  TRIGGERS: Queue<TriggerMessage>;
  RUN_STREAM: DurableObjectNamespace;
  SCHEDULER: DurableObjectNamespace;
  AI?: unknown;
  /** Worker Loader binding for the isolate sandbox. Optional. */
  JS_LOADER?: unknown;
  TORKFLOW_ENV: string;
  PAYLOAD_SPILL_BYTES: string;
  /** Root key-encryption key, from the Workers Secrets Store. */
  CREDENTIAL_KEK?: string;
}

export interface TriggerMessage {
  tenantId: string;
  workflowId: string;
  versionId?: string;
  triggerType: "schedule" | "webhook" | "api" | "manual";
  triggerRef?: string;
  input: Record<string, unknown>;
}

export type { TorkflowRunner };
