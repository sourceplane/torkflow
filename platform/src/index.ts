import { Hono } from "hono";
import { api } from "./api/router.js";
import type { Env, TriggerMessage } from "./env.js";
import { launchRun } from "./service/launch.js";
import { timingSafeEqual } from "./store/ids.js";
import { nextRunAt } from "./triggers/cron.js";

export { TorkflowRunner } from "./runner.js";
export { RunStream } from "./do/run-stream.js";
export { ScheduleKeeper } from "./do/scheduler.js";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ ok: true, env: c.env.TORKFLOW_ENV }));

app.route("/", api);

/**
 * Webhook ingest.
 *
 * Deliveries are verified, acknowledged immediately and queued. A burst of a
 * thousand deliveries must not collide with the platform's instance-creation
 * rate limit, and the sender should not wait on a workflow start either way.
 */
app.post("/hooks/:token", async (c) => {
  const token = c.req.param("token");

  const trigger = await c.env.DB.prepare(
    `SELECT id, tenant_id, workflow_id, enabled, webhook_secret, input_json
       FROM triggers WHERE webhook_token = ? AND type = 'webhook'`,
  )
    .bind(token)
    .first<{
      id: string;
      tenant_id: string;
      workflow_id: string;
      enabled: number;
      webhook_secret: ArrayBuffer | null;
      input_json: string | null;
    }>();

  // Same response whether the token is unknown or disabled — a probe should not
  // be able to enumerate live webhook URLs.
  if (!trigger || trigger.enabled !== 1) return c.json({ error: "not found" }, 404);

  const raw = await c.req.text();

  if (trigger.webhook_secret) {
    const signature = c.req.header("X-Torkflow-Signature") ?? "";
    const expected = await hmacHex(trigger.webhook_secret, raw);
    if (!timingSafeEqual(signature, expected)) {
      return c.json({ error: "invalid signature" }, 401);
    }
  }

  let body: unknown;
  try {
    body = raw === "" ? {} : JSON.parse(raw);
  } catch {
    return c.json({ error: "body must be JSON" }, 400);
  }

  const defaults = trigger.input_json ? (JSON.parse(trigger.input_json) as Record<string, unknown>) : {};
  const payload = body !== null && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : { body };

  await c.env.TRIGGERS.send({
    tenantId: trigger.tenant_id,
    workflowId: trigger.workflow_id,
    triggerType: "webhook",
    triggerRef: trigger.id,
    input: { ...defaults, ...payload },
  });

  return c.json({ accepted: true }, 202);
});

async function hmacHex(secret: ArrayBuffer, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    secret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default {
  fetch: app.fetch,

  /**
   * Queue consumer for trigger deliveries.
   *
   * Each message is one run to start. Failures are retried by the queue, and a
   * message that keeps failing lands in the dead-letter queue rather than being
   * dropped.
   */
  async queue(batch: MessageBatch<TriggerMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await launchRun(env, {
          tenantId: message.body.tenantId,
          workflowId: message.body.workflowId,
          triggerType: message.body.triggerType === "schedule" ? "schedule" : "webhook",
          ...(message.body.triggerRef ? { triggerRef: message.body.triggerRef } : {}),
          ...(message.body.versionId ? { versionId: message.body.versionId } : {}),
          input: message.body.input,
        });
        message.ack();
      } catch (error) {
        // A definition problem will fail identically on every retry, so there is
        // nothing to gain from re-queueing it.
        const permanent =
          error instanceof Error && /invalid|unknown action|no published version/i.test(error.message);
        if (permanent) {
          await env.DB.prepare(
            `INSERT INTO audit_log (id, tenant_id, actor, action, subject, detail, ts)
             VALUES (?, ?, 'system', 'trigger.rejected', ?, ?, ?)`,
          )
            .bind(
              `aud_${crypto.randomUUID()}`,
              message.body.tenantId,
              message.body.workflowId,
              error.message,
              Date.now(),
            )
            .run();
          message.ack();
        } else {
          message.retry();
        }
      }
    }
  },

  /**
   * Sweeper.
   *
   * Per-schedule timing comes from Durable Object alarms. This tick only catches
   * schedules whose alarm did not fire — an object that was never installed, or
   * a `next_run_at` left behind by a failed write.
   */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(sweepMissedSchedules(env));
  },
};

async function sweepMissedSchedules(env: Env): Promise<void> {
  const now = Date.now();
  // A minute of slack, so this never races an alarm that is about to fire.
  const overdue = now - 60_000;

  const { results } = await env.DB.prepare(
    `SELECT id, tenant_id, workflow_id, cron, timezone, input_json, next_run_at
       FROM triggers
      WHERE type = 'schedule' AND enabled = 1
        AND (next_run_at IS NULL OR next_run_at < ?)
      LIMIT 100`,
  )
    .bind(overdue)
    .all<{
      id: string;
      tenant_id: string;
      workflow_id: string;
      cron: string;
      timezone: string | null;
      input_json: string | null;
      next_run_at: number | null;
    }>();

  for (const row of results) {
    const stub = env.SCHEDULER.get(env.SCHEDULER.idFromName(row.id));

    // Re-installing is idempotent: it rewrites the alarm from the current time,
    // which is exactly what a missed schedule needs.
    await stub.fetch("https://schedule/install", {
      method: "POST",
      body: JSON.stringify({
        triggerId: row.id,
        tenantId: row.tenant_id,
        workflowId: row.workflow_id,
        cron: row.cron,
        timezone: row.timezone ?? "UTC",
        input: row.input_json ? JSON.parse(row.input_json) : {},
        enabled: true,
      }),
    });

    // A schedule that was genuinely due while nothing was armed still owes a
    // run; fire it once rather than silently skipping the window.
    if (row.next_run_at !== null && row.next_run_at < overdue) {
      await env.TRIGGERS.send({
        tenantId: row.tenant_id,
        workflowId: row.workflow_id,
        triggerType: "schedule",
        triggerRef: row.id,
        input: row.input_json ? JSON.parse(row.input_json) : {},
      });
      await env.DB.prepare(`UPDATE triggers SET last_run_at = ?, next_run_at = ? WHERE id = ?`)
        .bind(now, nextRunAt(row.cron, now, row.timezone ?? "UTC"), row.id)
        .run();
    }
  }
}
