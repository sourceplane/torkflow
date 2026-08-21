import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.js";
import { launchRun } from "../service/launch.js";
import { nextRunAt } from "../triggers/cron.js";

interface ScheduleState {
  triggerId: string;
  tenantId: string;
  workflowId: string;
  cron: string;
  timezone: string;
  input: Record<string, unknown>;
  enabled: boolean;
}

/**
 * One Durable Object per schedule, firing on its own alarm.
 *
 * A Worker cron trigger is per-Worker and UTC-only, so it cannot express "every
 * weekday at 09:00 Europe/Berlin for tenant X". An alarm per schedule can, and
 * it fires at the right minute rather than on a shared tick. The Worker's cron
 * trigger stays on as a sweeper for alarms that were missed.
 */
export class ScheduleKeeper extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {
      case "/install": {
        const state = (await request.json()) as ScheduleState;
        await this.ctx.storage.put("state", state);
        await this.reschedule(state);
        return Response.json({ ok: true, nextRunAt: await this.ctx.storage.getAlarm() });
      }
      case "/uninstall": {
        await this.ctx.storage.deleteAlarm();
        await this.ctx.storage.deleteAll();
        return Response.json({ ok: true });
      }
      case "/status": {
        return Response.json({
          state: (await this.ctx.storage.get<ScheduleState>("state")) ?? null,
          nextRunAt: await this.ctx.storage.getAlarm(),
        });
      }
      default:
        return new Response("not found", { status: 404 });
    }
  }

  async alarm(): Promise<void> {
    const state = await this.ctx.storage.get<ScheduleState>("state");
    if (!state || !state.enabled) return;

    // Reschedule first. If the launch throws, the next occurrence is already
    // armed — a failed run must not silently stop the schedule.
    await this.reschedule(state);

    try {
      await launchRun(this.env, {
        tenantId: state.tenantId,
        workflowId: state.workflowId,
        triggerType: "schedule",
        triggerRef: state.triggerId,
        input: state.input,
      });
      await this.env.DB.prepare(`UPDATE triggers SET last_run_at = ? WHERE id = ?`)
        .bind(Date.now(), state.triggerId)
        .run();
    } catch (error) {
      // Record it and move on; the schedule stays armed.
      await this.env.DB.prepare(
        `INSERT INTO audit_log (id, tenant_id, actor, action, subject, detail, ts)
         VALUES (?, ?, 'system', 'schedule.failed', ?, ?, ?)`,
      )
        .bind(
          `aud_${crypto.randomUUID()}`,
          state.tenantId,
          state.triggerId,
          (error as Error).message,
          Date.now(),
        )
        .run();
    }
  }

  private async reschedule(state: ScheduleState): Promise<void> {
    if (!state.enabled) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    const next = nextRunAt(state.cron, Date.now(), state.timezone);
    if (next === null) return;

    await this.ctx.storage.setAlarm(next);
    await this.env.DB.prepare(`UPDATE triggers SET next_run_at = ? WHERE id = ?`)
      .bind(next, state.triggerId)
      .run();
  }
}
