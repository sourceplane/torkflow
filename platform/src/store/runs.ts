import type { Env } from "../env.js";
import type { RunRecorder, StepObservation } from "../engine/ports.js";
import type { StepResult } from "../engine/driver.js";

/**
 * Run persistence.
 *
 * Step rows are upserted rather than inserted, because a Workflows step can be
 * retried and the driver reports each attempt. The row always reflects the
 * latest attempt, and the R2 payload objects are keyed by run and step, so a
 * retry overwrites rather than accumulating.
 */

/** How large a step payload may be before it goes to R2 instead of D1. */
const INLINE_PAYLOAD_LIMIT = 16_384;

export interface RunRow {
  id: string;
  tenant_id: string;
  workflow_id: string;
  version_id: string;
  instance_id: string | null;
  status: string;
  trigger_type: string;
  trigger_input: string | null;
  outputs: string | null;
  error: string | null;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
  duration_ms: number | null;
}

export async function createRun(
  env: Env,
  run: {
    id: string;
    tenantId: string;
    workflowId: string;
    versionId: string;
    triggerType: string;
    triggerRef?: string;
    input: Record<string, unknown>;
    resumedFrom?: string;
  },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO runs (id, tenant_id, workflow_id, version_id, status, trigger_type, trigger_ref, trigger_input, resumed_from, created_at)
     VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
  )
    .bind(
      run.id,
      run.tenantId,
      run.workflowId,
      run.versionId,
      run.triggerType,
      run.triggerRef ?? null,
      JSON.stringify(run.input),
      run.resumedFrom ?? null,
      Date.now(),
    )
    .run();
}

export async function markRunStarted(env: Env, runId: string, instanceId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE runs SET status = 'running', instance_id = ?, started_at = ? WHERE id = ?`,
  )
    .bind(instanceId, Date.now(), runId)
    .run();
}

export async function markRunFinished(
  env: Env,
  runId: string,
  result: { status: "success" | "failed"; outputs?: Record<string, unknown>; error?: string },
): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `UPDATE runs
        SET status = ?, outputs = ?, error = ?, ended_at = ?,
            duration_ms = CASE WHEN started_at IS NULL THEN NULL ELSE ? - started_at END
      WHERE id = ?`,
  )
    .bind(
      result.status,
      result.outputs ? JSON.stringify(result.outputs) : null,
      result.error ?? null,
      now,
      now,
      runId,
    )
    .run();
}

export async function getRun(env: Env, tenantId: string, runId: string): Promise<RunRow | null> {
  return env.DB.prepare(`SELECT * FROM runs WHERE id = ? AND tenant_id = ?`)
    .bind(runId, tenantId)
    .first<RunRow>();
}

export async function listRunSteps(env: Env, runId: string): Promise<StepResult[]> {
  const { results } = await env.DB.prepare(
    `SELECT name, status, error, branch, duration_ms FROM run_steps WHERE run_id = ? ORDER BY started_at`,
  )
    .bind(runId)
    .all<{
      name: string;
      status: string;
      error: string | null;
      branch: string | null;
      duration_ms: number | null;
    }>();

  return results.map((row) => ({
    name: row.name,
    status: row.status as StepResult["status"],
    ...(row.error ? { error: row.error } : {}),
    ...(row.branch ? { branch: row.branch } : {}),
    ...(row.duration_ms !== null ? { durationMs: row.duration_ms } : {}),
  }));
}

/**
 * Reads the prior run's succeeded steps and their outputs, for resume.
 *
 * Only SUCCEEDED steps are seeded — never SKIPPED. A step skipped because its
 * upstream failed must re-run, or resuming would silently preserve the effect
 * of the failure it was meant to recover from. Same rule as
 * `backend.readPriorSucceeded` in the CLI.
 */
export async function readResumeSeed(
  env: Env,
  runId: string,
): Promise<{ completed: string[]; outputs: Record<string, unknown>; branches: Record<string, string> }> {
  const { results } = await env.DB.prepare(
    `SELECT name, branch, output_json, output_ref FROM run_steps
      WHERE run_id = ? AND status = 'success' ORDER BY name`,
  )
    .bind(runId)
    .all<{ name: string; branch: string | null; output_json: string | null; output_ref: string | null }>();

  const completed: string[] = [];
  const outputs: Record<string, unknown> = {};
  const branches: Record<string, string> = {};

  for (const row of results) {
    completed.push(row.name);
    if (row.branch) branches[row.name] = row.branch;
    if (row.output_json) {
      outputs[row.name] = JSON.parse(row.output_json);
    } else if (row.output_ref) {
      const object = await env.PAYLOADS.get(row.output_ref);
      if (object) outputs[row.name] = await object.json();
    }
  }
  return { completed, outputs, branches };
}

/** Persists step transitions and run logs, and fans them to the live stream. */
export class D1RunRecorder implements RunRecorder {
  private sequence = 0;

  constructor(
    private readonly env: Env,
    private readonly runId: string,
    private readonly stream?: DurableObjectStub,
  ) {}

  async step(observation: StepObservation): Promise<void> {
    const input = await this.store(observation.input, `${observation.name}.input`);
    const output = await this.store(observation.output, `${observation.name}.output`);

    await this.env.DB.prepare(
      `INSERT INTO run_steps
         (run_id, name, status, attempt, branch, error, input_json, input_ref, output_json, output_ref, started_at, ended_at, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (run_id, name) DO UPDATE SET
         status = excluded.status,
         attempt = excluded.attempt,
         branch = COALESCE(excluded.branch, run_steps.branch),
         error = excluded.error,
         input_json = COALESCE(excluded.input_json, run_steps.input_json),
         input_ref = COALESCE(excluded.input_ref, run_steps.input_ref),
         output_json = COALESCE(excluded.output_json, run_steps.output_json),
         output_ref = COALESCE(excluded.output_ref, run_steps.output_ref),
         ended_at = excluded.ended_at,
         duration_ms = excluded.duration_ms`,
    )
      .bind(
        this.runId,
        observation.name,
        observation.status,
        observation.attempt,
        observation.branch ?? null,
        observation.error ?? null,
        input.json,
        input.ref,
        output.json,
        output.ref,
        observation.startedAt || null,
        observation.endedAt ?? null,
        observation.durationMs ?? null,
      )
      .run();

    await this.publish({ type: "step", step: observation });
  }

  async log(line: string): Promise<void> {
    const seq = this.sequence++;
    await this.env.DB.prepare(
      `INSERT INTO run_logs (run_id, seq, ts, line) VALUES (?, ?, ?, ?)
       ON CONFLICT (run_id, seq) DO NOTHING`,
    )
      .bind(this.runId, seq, Date.now(), line)
      .run();
    await this.publish({ type: "log", line });
  }

  /** Small payloads stay in D1; anything larger goes to R2 by reference. */
  private async store(
    value: unknown,
    suffix: string,
  ): Promise<{ json: string | null; ref: string | null }> {
    if (value === undefined) return { json: null, ref: null };
    const encoded = JSON.stringify(value) ?? "null";
    if (encoded.length <= INLINE_PAYLOAD_LIMIT) return { json: encoded, ref: null };

    const key = `runs/${this.runId}/${suffix}.json`;
    await this.env.PAYLOADS.put(key, encoded, {
      httpMetadata: { contentType: "application/json" },
    });
    return { json: null, ref: key };
  }

  private async publish(event: unknown): Promise<void> {
    if (!this.stream) return;
    try {
      await this.stream.fetch("https://run/publish", {
        method: "POST",
        body: JSON.stringify(event),
      });
    } catch {
      // Live streaming is best-effort; losing a frame must never fail a run.
    }
  }
}
