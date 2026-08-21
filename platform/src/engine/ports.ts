import type { ActionServices } from "../actions/types.js";
import type { BundleReader } from "../expression/resolve.js";

/**
 * The ports the driver runs against.
 *
 * The driver never imports a Cloudflare binding directly. It talks to these
 * interfaces, which the runner satisfies with `WorkflowStep`, R2 and D1 in
 * production and which tests satisfy with in-memory fakes. That is what makes
 * the replay semantics testable without workerd.
 */

export interface StepConfig {
  retries?: {
    limit: number;
    delay: string | number;
    backoff?: "constant" | "linear" | "exponential";
  };
  timeout?: string | number;
}

/** The subset of Cloudflare's `WorkflowStep` the driver uses. */
export interface DriverStep {
  do<T>(name: string, config: StepConfig, callback: () => Promise<T>): Promise<T>;
  sleep(name: string, duration: string | number): Promise<void>;
  waitForEvent<T>(name: string, options: { type: string; timeout?: string | number }): Promise<T>;
}

/** Where step results too large for a step return value are parked. */
export interface PayloadStore {
  put(key: string, value: unknown): Promise<void>;
  get(key: string): Promise<unknown>;
}

/**
 * Resolves a workflow's named connections to credential payloads.
 *
 * Injected credentials are the exclusive source, exactly as in the CLI's
 * backend mode: a step naming a connection the caller did not grant fails
 * closed rather than falling back to a file or an environment variable.
 */
export interface ConnectionResolver {
  resolve(connectionName: string): Promise<Record<string, unknown>>;
}

export interface StepObservation {
  name: string;
  status: "running" | "success" | "failed" | "skipped" | "waiting";
  attempt: number;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  branch?: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
}

/** Receives step transitions for persistence and live streaming. */
export interface RunRecorder {
  step(observation: StepObservation): Promise<void>;
  log(line: string): Promise<void>;
}

export interface DriverPorts {
  step: DriverStep;
  recorder: RunRecorder;
  connections: ConnectionResolver;
  services: ActionServices;
  payloads?: PayloadStore;
  bundle?: BundleReader;
  /** Spill a step result to the payload store above this many JSON bytes. */
  spillBytes?: number;
  /** Deterministic identity of this run, for action metadata. */
  runId: string;
  executionId: string;
  tenantId: string;
}

/** No-op recorder, for tests and for runs that need no observability. */
export const nullRecorder: RunRecorder = {
  async step() {},
  async log() {},
};

/** Fails every connection lookup — the correct default when none were granted. */
export const noConnections: ConnectionResolver = {
  async resolve(name: string): Promise<Record<string, unknown>> {
    throw new Error(`connection ${JSON.stringify(name)} was not provided to this run`);
  },
};
