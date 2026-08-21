import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { ActionRegistry } from "./actions/registry.js";
import { effectiveActionRef } from "./workflow/types.js";
import { WorkflowDriver, type RunResult } from "./engine/driver.js";
import type { DriverPorts, DriverStep, PayloadStore } from "./engine/ports.js";
import type { Env } from "./env.js";
import { bundleReader } from "./store/bundles.js";
import { connectionResolver } from "./store/credentials.js";
import {
  D1RunRecorder,
  markRunFinished,
  markRunStarted,
  readResumeSeed,
} from "./store/runs.js";
import { validateWorkflow } from "./workflow/parse.js";

export interface RunParams {
  runId: string;
  tenantId: string;
  workflowId: string;
  versionId: string;
  /** Content digest of the bundle. Pinned, so replays read the same definition. */
  digest: string;
  /** Parsed spec, passed in so the instance need not hit D1 to start. */
  spec: unknown;
  with: Record<string, unknown>;
  /** Run id to resume from — only its succeeded steps are seeded. */
  resumeFrom?: string;
}

/**
 * One Cloudflare Workflow instance per workflow execution.
 *
 * The instance owns durability: `step.do` results survive eviction, `step.sleep`
 * hibernates the instance without holding a concurrency slot, and
 * `step.waitForEvent` parks an approval gate for as long as it takes. All this
 * class does is adapt those primitives to the driver's ports and record the
 * outcome.
 */
export class TorkflowRunner extends WorkflowEntrypoint<Env, RunParams> {
  async run(event: WorkflowEvent<RunParams>, step: WorkflowStep): Promise<RunResult> {
    const params = event.payload;
    const env = this.env;

    // Validation is cheap and deterministic, so it happens outside a step —
    // a replay must reach the identical graph before issuing any step name.
    const workflow = validateWorkflow(params.spec);
    const registry = ActionRegistry.default();

    // The driver's port is the same `step` object with a narrower type. Going
    // through it keeps the runner's own bookkeeping on exactly the same
    // durability semantics as the workflow's steps, and sidesteps the
    // platform's `Serializable<T>` inference, which cannot express the
    // `Record<string, unknown>` payloads a dynamic workflow engine deals in.
    const durable = step as unknown as DriverStep;

    // Bookkeeping that must not be repeated on replay goes in a step.
    await durable.do("run:start", { retries: { limit: 3, delay: "1 second", backoff: "linear" } }, async () => {
      await markRunStarted(env, params.runId, event.instanceId);
      return { started: true };
    });

    let seed: Awaited<ReturnType<typeof readResumeSeed>> | undefined;
    if (params.resumeFrom) {
      seed = await durable.do("run:resume-seed", { retries: { limit: 3, delay: "1 second" } }, () =>
        readResumeSeed(env, params.resumeFrom!),
      );
    }

    // A step naming a connection tells us what credential type it must have, so
    // the resolver can reject a mismatch before the action ever sees it.
    const expectedTypes = new Map<string, string>();
    for (const declared of workflow.spec.steps) {
      if (!declared.connection) continue;
      const action = registry.get(effectiveActionRef(declared));
      if (action?.credentialType) expectedTypes.set(declared.connection, action.credentialType);
    }

    const stream = env.RUN_STREAM.get(env.RUN_STREAM.idFromName(params.runId));
    const recorder = new D1RunRecorder(env, params.runId, stream);

    const payloads: PayloadStore = {
      async put(key, value) {
        await env.PAYLOADS.put(key, JSON.stringify(value), {
          httpMetadata: { contentType: "application/json" },
        });
      },
      async get(key) {
        const object = await env.PAYLOADS.get(key);
        if (!object) throw new Error(`payload ${key} not found`);
        return object.json();
      },
    };

    const ports: DriverPorts = {
      step: durable,
      recorder,
      payloads,
      bundle: bundleReader(env, params.digest),
      connections: connectionResolver(env, params.tenantId, expectedTypes),
      services: {
        ...(env.AI ? { ai: env.AI } : {}),
        log: (line: string) => {
          void recorder.log(line);
        },
      },
      spillBytes: Number(env.PAYLOAD_SPILL_BYTES) || 262_144,
      runId: params.runId,
      executionId: event.instanceId,
      tenantId: params.tenantId,
    };

    const driver = new WorkflowDriver(workflow, registry, ports);
    const result = await driver.run({
      with: params.with,
      ...(seed ? { seed } : {}),
    });

    // Sealing the run is a side effect, so it belongs in a step: a replay after
    // the driver finished must not rewrite the row.
    await durable.do("run:finish", { retries: { limit: 5, delay: "2 seconds", backoff: "linear" } }, async () => {
      await markRunFinished(env, params.runId, {
        status: result.status,
        ...(result.outputs ? { outputs: result.outputs } : {}),
        ...(result.error ? { error: result.error } : {}),
      });
      try {
        await stream.fetch("https://run/publish", {
          method: "POST",
          body: JSON.stringify({ type: "run", status: result.status, outputs: result.outputs }),
        });
      } catch {
        // Best-effort live update.
      }
      return { sealed: true };
    });

    return result;
  }
}
