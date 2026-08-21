import { Hono } from "hono";
import { ActionRegistry } from "../actions/registry.js";
import type { Env } from "../env.js";
import { LaunchError, checkActionsExist, launchRun, resolveVersion } from "../service/launch.js";
import { putBundle } from "../store/bundles.js";
import { putConnection } from "../store/credentials.js";
import { newId, sha256Hex, timingSafeEqual } from "../store/ids.js";
import { getRun, listRunSteps } from "../store/runs.js";
import { parseCron } from "../triggers/cron.js";
import { parseWorkflow, WorkflowParseError } from "../workflow/parse.js";
import { workflowId as workflowIdOf, type ScheduleTrigger, type Workflow } from "../workflow/types.js";

type Variables = { tenantId: string; keyId: string };

export const api = new Hono<{ Bindings: Env; Variables: Variables }>();

// ---- authentication --------------------------------------------------------

/**
 * Every route below `/v1` needs a tenant-scoped API key. The key is hashed on
 * arrival and compared against the stored hash, so a database read never yields
 * a usable credential.
 */
api.use("/v1/*", async (c, next) => {
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (token === "") {
    return c.json({ error: "missing Authorization: Bearer <api-key>" }, 401);
  }

  const row = await c.env.DB.prepare(
    `SELECT id, tenant_id FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL`,
  )
    .bind(await sha256Hex(token))
    .first<{ id: string; tenant_id: string }>();

  if (!row) return c.json({ error: "invalid API key" }, 401);

  c.set("tenantId", row.tenant_id);
  c.set("keyId", row.id);

  // Last-used tracking is observability, not correctness — never block on it.
  c.executionCtx.waitUntil(
    c.env.DB.prepare(`UPDATE api_keys SET last_used_at = ? WHERE id = ?`)
      .bind(Date.now(), row.id)
      .run(),
  );

  await next();
});

function launchFailure(error: unknown): { body: Record<string, unknown>; status: number } {
  if (error instanceof LaunchError) {
    return {
      body: { error: error.message, ...(error.detail ? { detail: error.detail } : {}) },
      status: error.status,
    };
  }
  if (error instanceof WorkflowParseError) {
    return { body: { error: "workflow is invalid", detail: error.issues }, status: 422 };
  }
  return { body: { error: (error as Error).message }, status: 500 };
}

// ---- catalog ---------------------------------------------------------------

/** The action catalog, as the builder's picker renders it. */
api.get("/v1/actions", (c) => {
  const actions = ActionRegistry.default()
    .list()
    .map((action) => ({
      name: action.name,
      module: action.module,
      version: action.version,
      description: action.description,
      credentialType: action.credentialType ?? null,
      timeoutSeconds: action.timeoutSeconds,
      capabilities: action.capabilities ?? [],
      inputSchema: action.inputSchema ?? null,
      outputSchema: action.outputSchema ?? null,
      /** Sleeps and approvals are durable primitives, not ordinary calls. */
      durable: action.driverHandled ?? null,
    }));
  return c.json({ actions });
});

// ---- workflows -------------------------------------------------------------

/**
 * Validate a definition without storing it — what the builder calls on every
 * keystroke, and what a CI check calls on a pull request.
 */
api.post("/v1/workflows/validate", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { yaml?: string };
  if (typeof body.yaml !== "string") return c.json({ error: "expected { yaml }" }, 400);

  try {
    const workflow = parseWorkflow(body.yaml);
    checkActionsExist(workflow, ActionRegistry.default());
    return c.json({
      valid: true,
      name: workflow.metadata.name,
      steps: workflow.spec.steps.map((step) => step.name),
      outputs: Object.keys(workflow.spec.outputs ?? {}),
    });
  } catch (error) {
    const { body: failure, status } = launchFailure(error);
    return c.json({ valid: false, ...failure }, status as 400);
  }
});

/**
 * Publish a workflow version.
 *
 * Versions are immutable and content-addressed. Publishing the identical bundle
 * twice is a no-op that returns the existing version, so a redeploy from CI
 * does not litter the history.
 */
api.post("/v1/workflows", async (c) => {
  const tenantId = c.get("tenantId");
  const body = (await c.req.json().catch(() => ({}))) as {
    yaml?: string;
    files?: { path: string; content: string }[];
    publish?: boolean;
  };
  if (typeof body.yaml !== "string") return c.json({ error: "expected { yaml }" }, 400);

  let workflow: Workflow;
  try {
    workflow = parseWorkflow(body.yaml);
    checkActionsExist(workflow, ActionRegistry.default());
  } catch (error) {
    const { body: failure, status } = launchFailure(error);
    return c.json(failure, status as 400);
  }

  const name = workflow.metadata.name;
  const now = Date.now();

  const files = [{ path: "workflow.yaml", content: body.yaml }, ...(body.files ?? [])];
  let digest: string;
  try {
    digest = await putBundle(c.env, files);
  } catch (error) {
    return c.json({ error: (error as Error).message }, 400);
  }

  const existing = await c.env.DB.prepare(
    `SELECT id FROM workflows WHERE tenant_id = ? AND name = ?`,
  )
    .bind(tenantId, name)
    .first<{ id: string }>();

  const workflowRowId = existing?.id ?? newId("wf");
  if (!existing) {
    await c.env.DB.prepare(
      `INSERT INTO workflows (id, tenant_id, name, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(workflowRowId, tenantId, name, workflow.metadata.description ?? null, now, now)
      .run();
  }

  // Same content as the current live version means nothing changed.
  const duplicate = await c.env.DB.prepare(
    `SELECT id, version FROM workflow_versions WHERE workflow_id = ? AND digest = ?`,
  )
    .bind(workflowRowId, digest)
    .first<{ id: string; version: number }>();

  if (duplicate) {
    return c.json({
      workflowId: workflowRowId,
      versionId: duplicate.id,
      version: duplicate.version,
      digest,
      unchanged: true,
    });
  }

  const previous = await c.env.DB.prepare(
    `SELECT COALESCE(MAX(version), 0) AS v FROM workflow_versions WHERE workflow_id = ?`,
  )
    .bind(workflowRowId)
    .first<{ v: number }>();

  const version = (previous?.v ?? 0) + 1;
  const versionId = newId("wfv");
  const publish = body.publish !== false;

  await c.env.DB.prepare(
    `INSERT INTO workflow_versions
       (id, workflow_id, version, digest, spec_json, source_yaml, status, created_at, published_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      versionId,
      workflowRowId,
      version,
      digest,
      JSON.stringify(workflow),
      body.yaml,
      publish ? "published" : "draft",
      now,
      publish ? now : null,
    )
    .run();

  if (publish) {
    await c.env.DB.prepare(`UPDATE workflows SET live_version_id = ?, updated_at = ? WHERE id = ?`)
      .bind(versionId, now, workflowRowId)
      .run();
    await syncScheduleTriggers(c.env, tenantId, workflowRowId, workflow);
  }

  return c.json(
    { workflowId: workflowRowId, versionId, version, digest, status: publish ? "published" : "draft" },
    201,
  );
});

api.get("/v1/workflows", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT w.id, w.name, w.description, w.live_version_id, w.created_at, w.updated_at,
            (SELECT COUNT(*) FROM runs r WHERE r.workflow_id = w.id) AS run_count
       FROM workflows w
      WHERE w.tenant_id = ? AND w.archived_at IS NULL
      ORDER BY w.updated_at DESC
      LIMIT 100`,
  )
    .bind(c.get("tenantId"))
    .all();
  return c.json({ workflows: results });
});

api.get("/v1/workflows/:id", async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT w.*, v.version, v.digest, v.source_yaml
       FROM workflows w
       LEFT JOIN workflow_versions v ON v.id = w.live_version_id
      WHERE w.id = ? AND w.tenant_id = ?`,
  )
    .bind(c.req.param("id"), c.get("tenantId"))
    .first();
  if (!row) return c.json({ error: "workflow not found" }, 404);
  return c.json(row);
});

// ---- runs ------------------------------------------------------------------

api.post("/v1/workflows/:id/runs", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    with?: Record<string, unknown>;
    versionId?: string;
  };

  try {
    const result = await launchRun(c.env, {
      tenantId: c.get("tenantId"),
      workflowId: c.req.param("id"),
      triggerType: "api",
      triggerRef: c.get("keyId"),
      input: body.with ?? {},
      ...(body.versionId ? { versionId: body.versionId } : {}),
    });
    return c.json({ ...result, status: "queued" }, 202);
  } catch (error) {
    const { body: failure, status } = launchFailure(error);
    return c.json(failure, status as 400);
  }
});

api.get("/v1/runs", async (c) => {
  const status = c.req.query("status");
  const workflowId = c.req.query("workflowId");
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);

  const conditions = ["tenant_id = ?"];
  const bindings: unknown[] = [c.get("tenantId")];
  if (status) {
    conditions.push("status = ?");
    bindings.push(status);
  }
  if (workflowId) {
    conditions.push("workflow_id = ?");
    bindings.push(workflowId);
  }
  bindings.push(limit);

  const { results } = await c.env.DB.prepare(
    `SELECT id, workflow_id, version_id, status, trigger_type, error, created_at, started_at, ended_at, duration_ms
       FROM runs WHERE ${conditions.join(" AND ")}
      ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(...bindings)
    .all();

  return c.json({ runs: results });
});

api.get("/v1/runs/:id", async (c) => {
  const run = await getRun(c.env, c.get("tenantId"), c.req.param("id"));
  if (!run) return c.json({ error: "run not found" }, 404);

  const steps = await listRunSteps(c.env, run.id);
  return c.json({
    ...run,
    trigger_input: run.trigger_input ? JSON.parse(run.trigger_input) : null,
    outputs: run.outputs ? JSON.parse(run.outputs) : null,
    steps,
  });
});

api.get("/v1/runs/:id/logs", async (c) => {
  const run = await getRun(c.env, c.get("tenantId"), c.req.param("id"));
  if (!run) return c.json({ error: "run not found" }, 404);

  const { results } = await c.env.DB.prepare(
    `SELECT seq, ts, line FROM run_logs WHERE run_id = ? ORDER BY seq LIMIT 5000`,
  )
    .bind(run.id)
    .all();
  return c.json({ logs: results });
});

/** Live run stream — the browser's view of the DAG as it executes. */
api.get("/v1/runs/:id/stream", async (c) => {
  const run = await getRun(c.env, c.get("tenantId"), c.req.param("id"));
  if (!run) return c.json({ error: "run not found" }, 404);

  const stub = c.env.RUN_STREAM.get(c.env.RUN_STREAM.idFromName(run.id));
  return stub.fetch(new Request("https://run/stream", { headers: c.req.raw.headers }));
});

/**
 * Resume a failed run: re-execute only the steps that did not succeed.
 *
 * The new run pins the same version, so the definition cannot have shifted
 * underneath the steps being re-used.
 */
api.post("/v1/runs/:id/resume", async (c) => {
  const tenantId = c.get("tenantId");
  const previous = await getRun(c.env, tenantId, c.req.param("id"));
  if (!previous) return c.json({ error: "run not found" }, 404);
  if (previous.status !== "failed") {
    return c.json({ error: `only a failed run can be resumed (this one is ${previous.status})` }, 409);
  }

  try {
    const result = await launchRun(c.env, {
      tenantId,
      workflowId: previous.workflow_id,
      versionId: previous.version_id,
      triggerType: "replay",
      triggerRef: previous.id,
      input: previous.trigger_input ? JSON.parse(previous.trigger_input) : {},
      resumeFrom: previous.id,
    });
    return c.json({ ...result, resumedFrom: previous.id, status: "queued" }, 202);
  } catch (error) {
    const { body: failure, status } = launchFailure(error);
    return c.json(failure, status as 400);
  }
});

// ---- approvals -------------------------------------------------------------

api.get("/v1/approvals", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT a.* FROM approvals a
       JOIN runs r ON r.id = a.run_id
      WHERE r.tenant_id = ? AND a.status = 'pending'
      ORDER BY a.created_at DESC LIMIT 200`,
  )
    .bind(c.get("tenantId"))
    .all();
  return c.json({ approvals: results });
});

/**
 * Decide a pending approval.
 *
 * The decision is delivered to the waiting instance as an event; the instance's
 * `step.waitForEvent` wakes and takes the approve or reject branch.
 */
api.post("/v1/runs/:id/approvals/:step", async (c) => {
  const tenantId = c.get("tenantId");
  const runId = c.req.param("id");
  const stepName = c.req.param("step");

  const run = await getRun(c.env, tenantId, runId);
  if (!run) return c.json({ error: "run not found" }, 404);
  if (!run.instance_id) return c.json({ error: "run has no live instance" }, 409);

  const body = (await c.req.json().catch(() => ({}))) as {
    decision?: string;
    approver?: string;
    comment?: string;
  };
  if (body.decision !== "approve" && body.decision !== "reject") {
    return c.json({ error: 'expected { decision: "approve" | "reject" }' }, 400);
  }

  const instance = await c.env.RUNNER.get(run.instance_id);
  await instance.sendEvent({
    type: `approval:${stepName}`,
    payload: {
      decision: body.decision,
      approver: body.approver ?? c.get("keyId"),
      comment: body.comment ?? null,
    },
  });

  await c.env.DB.prepare(
    `UPDATE approvals SET status = ?, decided_by = ?, comment = ?, decided_at = ?
      WHERE run_id = ? AND step_name = ?`,
  )
    .bind(
      body.decision === "approve" ? "approved" : "rejected",
      body.approver ?? c.get("keyId"),
      body.comment ?? null,
      Date.now(),
      runId,
      stepName,
    )
    .run();

  return c.json({ ok: true, decision: body.decision });
});

// ---- connections -----------------------------------------------------------

api.get("/v1/connections", async (c) => {
  // Never the secret — only what it is and when it was last used.
  const { results } = await c.env.DB.prepare(
    `SELECT id, name, type, created_at, updated_at, last_used_at
       FROM connections WHERE tenant_id = ? ORDER BY name`,
  )
    .bind(c.get("tenantId"))
    .all();
  return c.json({ connections: results });
});

api.put("/v1/connections/:name", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    type?: string;
    payload?: Record<string, unknown>;
  };
  if (!body.type || !body.payload || typeof body.payload !== "object") {
    return c.json({ error: "expected { type, payload }" }, 400);
  }

  try {
    await putConnection(c.env, c.get("tenantId"), {
      id: newId("conn"),
      name: c.req.param("name"),
      type: body.type,
      payload: body.payload,
    });
  } catch (error) {
    return c.json({ error: (error as Error).message }, 500);
  }
  return c.json({ ok: true, name: c.req.param("name"), type: body.type });
});

api.delete("/v1/connections/:name", async (c) => {
  await c.env.DB.prepare(`DELETE FROM connections WHERE tenant_id = ? AND name = ?`)
    .bind(c.get("tenantId"), c.req.param("name"))
    .run();
  return c.json({ ok: true });
});

// ---- triggers --------------------------------------------------------------

api.get("/v1/triggers", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, workflow_id, type, name, enabled, cron, timezone, webhook_token, next_run_at, last_run_at
       FROM triggers WHERE tenant_id = ? ORDER BY created_at DESC`,
  )
    .bind(c.get("tenantId"))
    .all();
  return c.json({ triggers: results });
});

api.post("/v1/workflows/:id/triggers", async (c) => {
  const tenantId = c.get("tenantId");
  const workflowId = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as {
    type?: string;
    name?: string;
    cron?: string;
    timezone?: string;
    with?: Record<string, unknown>;
  };

  const owned = await c.env.DB.prepare(`SELECT id FROM workflows WHERE id = ? AND tenant_id = ?`)
    .bind(workflowId, tenantId)
    .first();
  if (!owned) return c.json({ error: "workflow not found" }, 404);

  const id = newId("trg");
  const now = Date.now();

  if (body.type === "schedule") {
    if (!body.cron) return c.json({ error: "a schedule trigger requires { cron }" }, 400);
    try {
      parseCron(body.cron);
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }

    const timezone = body.timezone ?? "UTC";
    await c.env.DB.prepare(
      `INSERT INTO triggers (id, tenant_id, workflow_id, type, name, enabled, cron, timezone, input_json, created_at)
       VALUES (?, ?, ?, 'schedule', ?, 1, ?, ?, ?, ?)`,
    )
      .bind(id, tenantId, workflowId, body.name ?? null, body.cron, timezone, JSON.stringify(body.with ?? {}), now)
      .run();

    await installSchedule(c.env, {
      triggerId: id,
      tenantId,
      workflowId,
      cron: body.cron,
      timezone,
      input: body.with ?? {},
      enabled: true,
    });

    return c.json({ id, type: "schedule", cron: body.cron, timezone }, 201);
  }

  if (body.type === "webhook") {
    const token = newId("whk").replace("whk_", "");
    const secret = crypto.getRandomValues(new Uint8Array(32));
    await c.env.DB.prepare(
      `INSERT INTO triggers (id, tenant_id, workflow_id, type, name, enabled, webhook_token, webhook_secret, input_json, created_at)
       VALUES (?, ?, ?, 'webhook', ?, 1, ?, ?, ?, ?)`,
    )
      .bind(id, tenantId, workflowId, body.name ?? null, token, secret.buffer, JSON.stringify(body.with ?? {}), now)
      .run();

    return c.json(
      {
        id,
        type: "webhook",
        url: `${new URL(c.req.url).origin}/hooks/${token}`,
        // Shown once. The signing secret is not readable afterwards.
        signingSecret: btoa(String.fromCharCode(...secret)),
      },
      201,
    );
  }

  return c.json({ error: 'trigger type must be "schedule" or "webhook"' }, 400);
});

api.delete("/v1/triggers/:id", async (c) => {
  const tenantId = c.get("tenantId");
  const id = c.req.param("id");

  const row = await c.env.DB.prepare(
    `SELECT id, type FROM triggers WHERE id = ? AND tenant_id = ?`,
  )
    .bind(id, tenantId)
    .first<{ id: string; type: string }>();
  if (!row) return c.json({ error: "trigger not found" }, 404);

  if (row.type === "schedule") {
    const stub = c.env.SCHEDULER.get(c.env.SCHEDULER.idFromName(id));
    await stub.fetch("https://schedule/uninstall", { method: "POST" });
  }
  await c.env.DB.prepare(`DELETE FROM triggers WHERE id = ?`).bind(id).run();
  return c.json({ ok: true });
});

// ---- helpers ---------------------------------------------------------------

async function installSchedule(
  env: Env,
  state: {
    triggerId: string;
    tenantId: string;
    workflowId: string;
    cron: string;
    timezone: string;
    input: Record<string, unknown>;
    enabled: boolean;
  },
): Promise<void> {
  const stub = env.SCHEDULER.get(env.SCHEDULER.idFromName(state.triggerId));
  await stub.fetch("https://schedule/install", {
    method: "POST",
    body: JSON.stringify(state),
  });
}

/**
 * Reconciles `spec.triggers` declared in the YAML with the stored triggers.
 *
 * Declaring a schedule in the workflow file keeps the definition and its cadence
 * in one reviewable artifact, which is what a GitOps workflow needs. Triggers
 * created through the API are left alone.
 */
async function syncScheduleTriggers(
  env: Env,
  tenantId: string,
  workflowRowId: string,
  workflow: Workflow,
): Promise<void> {
  const declared = (workflow.spec.triggers ?? []).filter(
    (trigger): trigger is ScheduleTrigger => trigger.type === "schedule",
  );

  const { results } = await env.DB.prepare(
    `SELECT id FROM triggers WHERE workflow_id = ? AND type = 'schedule' AND name LIKE 'spec:%'`,
  )
    .bind(workflowRowId)
    .all<{ id: string }>();

  // Drop the previous generation, then install the current one. Schedules are
  // cheap to recreate and this keeps the file authoritative.
  for (const row of results) {
    const stub = env.SCHEDULER.get(env.SCHEDULER.idFromName(row.id));
    await stub.fetch("https://schedule/uninstall", { method: "POST" });
    await env.DB.prepare(`DELETE FROM triggers WHERE id = ?`).bind(row.id).run();
  }

  for (const [index, trigger] of declared.entries()) {
    let cron: string;
    try {
      parseCron(trigger.cron);
      cron = trigger.cron;
    } catch {
      // The parser already validated field count; an unparseable expression
      // here should not block publishing the workflow itself.
      continue;
    }

    const id = newId("trg");
    const name = `spec:${trigger.name ?? `schedule-${index}`}`;
    const timezone = trigger.timezone ?? "UTC";

    await env.DB.prepare(
      `INSERT INTO triggers (id, tenant_id, workflow_id, type, name, enabled, cron, timezone, input_json, created_at)
       VALUES (?, ?, ?, 'schedule', ?, 1, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        tenantId,
        workflowRowId,
        name,
        cron,
        timezone,
        JSON.stringify(trigger.with ?? {}),
        Date.now(),
      )
      .run();

    await installSchedule(env, {
      triggerId: id,
      tenantId,
      workflowId: workflowRowId,
      cron,
      timezone,
      input: trigger.with ?? {},
      enabled: true,
    });
  }
}

export { timingSafeEqual, workflowIdOf, resolveVersion };
