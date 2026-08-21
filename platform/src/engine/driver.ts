import { ActionRegistry } from "../actions/registry.js";
import { formatGoDuration, resolveSleepMilliseconds } from "../actions/core.js";
import { NonRetryableActionError, type ActionRequest } from "../actions/types.js";
import { Graph } from "../dag/graph.js";
import { evaluateExpression } from "../expression/interpreter.js";
import { resolveParameters, resolveString } from "../expression/resolve.js";
import {
  effectiveActionRef,
  effectiveRetry,
  workflowId as workflowIdOf,
  type Step,
  type Workflow,
} from "../workflow/types.js";
import type { DriverPorts, StepConfig, StepObservation } from "./ports.js";

/**
 * The workflow driver.
 *
 * This replaces `internal/engine/scheduler.go`. The DAG semantics are the
 * same — readiness gates, branch edges, retries, fallbacks, the deadlock sweep
 * — but the execution model is inverted: instead of a goroutine pool polling a
 * channel, the driver issues `step.do` calls and lets Cloudflare Workflows own
 * durability.
 *
 * That inversion imposes one hard constraint: **the driver is replayed**. After
 * a failure or a hibernation, Workflows re-runs this code from the top and
 * serves already-completed `step.do` calls from cache. So the driver must be
 * deterministic — same inputs, same sequence of step names, every time. Three
 * rules follow, and each is a place the Go engine would have been unsafe:
 *
 *  1. No wall-clock reads and no randomness outside a step callback.
 *  2. No map-iteration ordering. Every collection the driver walks is sorted
 *     into the workflow's authored step order.
 *  3. No concurrency beyond `Promise.all` over a wave whose membership was
 *     computed deterministically.
 */

export type StepStatus = "PENDING" | "READY" | "SUCCEEDED" | "FAILED" | "SKIPPED";

export interface StepResult {
  name: string;
  status: "success" | "failed" | "skipped";
  error?: string;
  durationMs?: number;
  branch?: string;
}

export interface RunResult {
  status: "success" | "failed";
  outputs?: Record<string, unknown>;
  steps: StepResult[];
  error?: string;
}

export interface RunOptions {
  /** Trigger context — the workflow's declared inputs. */
  with?: Record<string, unknown>;
  /**
   * Resume: step names already succeeded in a prior run, with their outputs, to
   * be seeded as complete rather than re-executed. Mirrors WX6 in the CLI.
   */
  seed?: { completed: string[]; outputs: Record<string, unknown>; branches: Record<string, string> };
}

/** How a step result crosses the `step.do` boundary. */
type StepEnvelope =
  | { kind: "inline"; output: Record<string, unknown>; branch?: string; durationMs: number }
  | { kind: "ref"; key: string; branch?: string; durationMs: number };

const DEFAULT_MAX_PARALLEL = 5;
const DEFAULT_SPILL_BYTES = 262_144;
const DEFAULT_APPROVAL_TIMEOUT = "24 hours";

export class WorkflowDriver {
  private readonly workflow: Workflow;
  private readonly graph: Graph;
  private readonly registry: ActionRegistry;
  private readonly ports: DriverPorts;

  private readonly status = new Map<string, StepStatus>();
  private readonly satisfied = new Map<string, number>();
  private readonly results = new Map<string, StepResult>();
  private context: Record<string, unknown>;

  constructor(workflow: Workflow, registry: ActionRegistry, ports: DriverPorts) {
    this.workflow = workflow;
    this.graph = Graph.build(workflow);
    this.registry = registry;
    this.ports = ports;
    this.context = { Trigger: {}, Steps: {} };
  }

  async run(options: RunOptions = {}): Promise<RunResult> {
    this.context = { Trigger: options.with ?? {}, Steps: {} };

    for (const name of this.graph.order) {
      this.status.set(name, "PENDING");
      this.satisfied.set(name, 0);
    }

    let ready = this.graph.roots();
    for (const name of ready) this.status.set(name, "READY");

    // Resume seeding: steps that already succeeded are completed without
    // execution, their outputs restored, and their outbound edges unlocked
    // along the branch the prior run took.
    if (options.seed) {
      const steps = this.context.Steps as Record<string, unknown>;
      const unlocked: string[] = [];
      for (const name of this.graph.sortByAuthoredOrder(options.seed.completed)) {
        if (!this.graph.nodes.has(name) || this.status.get(name) === "SUCCEEDED") continue;
        this.status.set(name, "SUCCEEDED");
        if (name in options.seed.outputs) steps[name] = options.seed.outputs[name];
        this.results.set(name, { name, status: "skipped" });
        unlocked.push(...this.unlock(name, options.seed.branches[name]));
      }
      ready = this.graph.sortByAuthoredOrder(
        [...ready.filter((n) => this.status.get(n) === "READY"), ...unlocked],
      );
    }

    const maxParallel =
      this.workflow.spec.maxParallelSteps && this.workflow.spec.maxParallelSteps > 0
        ? this.workflow.spec.maxParallelSteps
        : DEFAULT_MAX_PARALLEL;

    while (ready.length > 0) {
      const wave = ready.slice(0, maxParallel);
      ready = ready.slice(wave.length);

      // Wave-parallel rather than a continuously-refilled pool. The Go
      // scheduler starts the next step the instant a slot frees; a wave waits
      // for its slowest member. The reachable set and the ordering constraints
      // are identical either way, and `Promise.all` keeps result ordering
      // deterministic where a `race` would not.
      const envelopes = await Promise.all(wave.map((name) => this.runStep(name)));

      const unlocked: string[] = [];
      for (const [index, envelope] of envelopes.entries()) {
        unlocked.push(...(await this.applyOutcome(wave[index]!, envelope)));
      }
      ready = this.graph.sortByAuthoredOrder([...ready, ...unlocked]);
    }

    // Steps still pending can never become ready — an upstream failed, or a
    // branch they sat behind was not taken. The Go scheduler resolves the same
    // stall by sweeping them to SKIPPED.
    for (const name of this.graph.order) {
      if (this.status.get(name) === "PENDING") {
        this.status.set(name, "SKIPPED");
        this.results.set(name, { name, status: "skipped" });
        await this.ports.recorder.step({
          name,
          status: "skipped",
          attempt: 1,
          startedAt: 0,
          error: "not reached",
        });
      }
    }

    return this.finish();
  }

  // ---- step execution ------------------------------------------------------

  /**
   * Runs one step. Returns its envelope, or null when the step was skipped by
   * its `skip` expression or failed.
   */
  private async runStep(name: string): Promise<StepEnvelope | Error | null> {
    const step = this.graph.step(name)!;
    this.status.set(name, "READY");

    // `skip` is evaluated in the driver: it is a pure function of the context,
    // so it costs no step and stays identical across replays.
    if (step.skip && step.skip !== "") {
      try {
        if (evaluateExpression(step.skip, this.context) === true) {
          return null;
        }
      } catch {
        // The Go engine ignores a failing skip expression and runs the step.
      }
    }

    const actionRef = effectiveActionRef(step);
    const action = this.registry.get(actionRef);
    if (!action) {
      return new NonRetryableActionError(`unknown action ${actionRef}`);
    }

    try {
      if (action.driverHandled === "sleep") return await this.runSleep(name, step);
      if (action.driverHandled === "approval") return await this.runApproval(name, step);
      return await this.runAction(name, step);
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  }

  /**
   * `core.sleep` becomes a durable `step.sleep`. A sleeping instance holds no
   * concurrency slot and burns no CPU, so a workflow can wait for days — the
   * CLI's `time.Sleep` blocks a worker for the whole duration.
   */
  private async runSleep(name: string, step: Step): Promise<StepEnvelope> {
    const input = await resolveParameters(step.parameters, this.context, {
      ...(this.ports.bundle ? { bundle: this.ports.bundle } : {}),
    });
    const milliseconds = resolveSleepMilliseconds(input);

    await this.ports.recorder.step({
      name,
      status: "waiting",
      attempt: 1,
      startedAt: 0,
      input,
    });
    await this.ports.step.sleep(`sleep:${name}`, milliseconds);

    return {
      kind: "inline",
      output: { duration: formatGoDuration(milliseconds), sleptMs: milliseconds },
      durationMs: milliseconds,
    };
  }

  /**
   * `core.approval` becomes `step.waitForEvent` — a durable human-in-the-loop
   * gate. This is what the CLI's contract reserves the `paused` status for, and
   * it is the shape Datadog's approval step takes.
   */
  private async runApproval(name: string, step: Step): Promise<StepEnvelope> {
    const input = await resolveParameters(step.parameters, this.context, {
      ...(this.ports.bundle ? { bundle: this.ports.bundle } : {}),
    });
    const timeout =
      typeof input.timeout === "string" && input.timeout !== ""
        ? input.timeout
        : DEFAULT_APPROVAL_TIMEOUT;

    await this.ports.recorder.step({
      name,
      status: "waiting",
      attempt: 1,
      startedAt: 0,
      input,
    });

    try {
      const event = await this.ports.step.waitForEvent<{
        payload?: { decision?: string; approver?: string; comment?: string };
      }>(`approval:${name}`, { type: `approval:${name}`, timeout });

      const payload = event?.payload ?? {};
      const approved = payload.decision === "approve";
      return {
        kind: "inline",
        output: {
          decision: approved ? "approve" : "reject",
          approved,
          approver: payload.approver ?? null,
          comment: payload.comment ?? null,
          timedOut: false,
        },
        branch: approved ? "approve" : "reject",
        durationMs: 0,
      };
    } catch {
      // The deadline passed. `onTimeout` decides which way the gate falls;
      // rejecting is the safe default for an unattended approval.
      const onTimeout = input.onTimeout === "approve" ? "approve" : "reject";
      return {
        kind: "inline",
        output: {
          decision: onTimeout,
          approved: onTimeout === "approve",
          approver: null,
          comment: null,
          timedOut: true,
        },
        branch: onTimeout,
        durationMs: 0,
      };
    }
  }

  /** Runs a catalog action inside a durable, retrying `step.do`. */
  private async runAction(name: string, step: Step): Promise<StepEnvelope> {
    const action = this.registry.get(effectiveActionRef(step))!;
    const config = this.stepConfig(step, action.timeoutSeconds);
    const context = this.context;
    const ports = this.ports;
    const registry = this.registry;
    const runId = this.ports.runId;

    // Everything with a side effect — parameter resolution (which may read the
    // bundle), credential resolution, the action call, persistence — happens
    // inside the callback, so a replay serves it from cache instead of redoing
    // it.
    return ports.step.do<StepEnvelope>(`step:${name}`, config, async () => {
      const startedAt = Date.now();
      let input: Record<string, unknown> = {};
      try {
        input = await resolveParameters(step.parameters, context, {
          ...(ports.bundle ? { bundle: ports.bundle } : {}),
        });

        await ports.recorder.step({ name, status: "running", attempt: 1, startedAt, input });

        let credential: Record<string, unknown> = {};
        if (step.connection && step.connection !== "") {
          credential = await ports.connections.resolve(step.connection);
        } else if (action.credentialType) {
          throw new NonRetryableActionError(
            `action ${action.name} requires connection type ${action.credentialType}, but the step declares none`,
          );
        }

        const timeoutSeconds =
          step.timeoutSeconds && step.timeoutSeconds > 0 ? step.timeoutSeconds : action.timeoutSeconds;
        const controller = new AbortController();
        const timer =
          timeoutSeconds > 0
            ? setTimeout(() => controller.abort(), timeoutSeconds * 1000)
            : undefined;

        const request: ActionRequest = {
          actionRef: action.name,
          stepName: name,
          input,
          credential,
          context,
          signal: controller.signal,
          services: ports.services,
          metadata: {
            workflowId: workflowIdOf(this.workflow),
            executionId: ports.executionId,
            runId,
            tenantId: ports.tenantId,
            attempt: 1,
          },
          ...(ports.bundle ? { bundle: ports.bundle } : {}),
        };

        try {
          const result = await registry.invoke(request);
          const durationMs = Date.now() - startedAt;

          await ports.recorder.step({
            name,
            status: "success",
            attempt: 1,
            startedAt,
            endedAt: Date.now(),
            durationMs,
            input,
            output: result.output,
            ...(result.branch ? { branch: result.branch } : {}),
          });

          return await this.envelope(name, result.output, result.branch, durationMs);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      } catch (error) {
        const message = (error as Error).message ?? String(error);
        await ports.recorder.step({
          name,
          status: "failed",
          attempt: 1,
          startedAt,
          endedAt: Date.now(),
          durationMs: Date.now() - startedAt,
          input,
          error: message,
        });
        throw error;
      }
    });
  }

  /**
   * Maps the workflow's retry strategy onto the platform's.
   *
   * The CLI's backoff is `baseDelay * (attempt + 1)` — linear — so `linear` is
   * the faithful mapping, not the platform's exponential default. A step with
   * no declared strategy gets `limit: 0`: torkflow does not retry unless asked,
   * and inheriting Workflows' default of five attempts would silently change
   * the behaviour of every existing workflow.
   */
  private stepConfig(step: Step, actionTimeoutSeconds: number): StepConfig {
    const retry = effectiveRetry(step);
    const timeoutSeconds =
      step.timeoutSeconds && step.timeoutSeconds > 0 ? step.timeoutSeconds : actionTimeoutSeconds;

    const config: StepConfig = {
      retries: {
        limit: retry?.maxRetries && retry.maxRetries > 0 ? retry.maxRetries : 0,
        delay: `${retry?.baseDelaySeconds ?? 0} seconds`,
        backoff: "linear",
      },
    };
    if (timeoutSeconds > 0) {
      // Give the platform a little more room than the in-action abort, so the
      // action's own error surfaces rather than an opaque platform timeout.
      config.timeout = `${timeoutSeconds + 10} seconds`;
    }
    return config;
  }

  /** Spills a large step output to the payload store rather than returning it. */
  private async envelope(
    name: string,
    output: Record<string, unknown>,
    branch: string | undefined,
    durationMs: number,
  ): Promise<StepEnvelope> {
    const limit = this.ports.spillBytes ?? DEFAULT_SPILL_BYTES;
    const encoded = JSON.stringify(output) ?? "{}";

    // Workflows caps a step's return value at 1 MiB, and torkflow step outputs
    // become workflow context — an HTTP response against a real API will exceed
    // it. Park the payload and return a reference.
    if (encoded.length > limit && this.ports.payloads) {
      const key = `runs/${this.ports.runId}/steps/${name}.json`;
      await this.ports.payloads.put(key, output);
      return { kind: "ref", key, ...(branch ? { branch } : {}), durationMs };
    }
    return { kind: "inline", output, ...(branch ? { branch } : {}), durationMs };
  }

  private async hydrate(envelope: StepEnvelope): Promise<Record<string, unknown>> {
    if (envelope.kind === "inline") return envelope.output;
    if (!this.ports.payloads) {
      throw new Error(`step result was spilled to ${envelope.key} but no payload store is configured`);
    }
    return (await this.ports.payloads.get(envelope.key)) as Record<string, unknown>;
  }

  // ---- outcome handling ----------------------------------------------------

  /** Applies one step's outcome and returns the steps it unlocked. */
  private async applyOutcome(name: string, outcome: StepEnvelope | Error | null): Promise<string[]> {
    const step = this.graph.step(name)!;

    // Skipped by its own `skip` expression. The Go engine does not schedule
    // outbound edges in this case, so downstream steps stall and are swept.
    if (outcome === null) {
      this.status.set(name, "SKIPPED");
      this.results.set(name, { name, status: "skipped" });
      await this.ports.recorder.step({ name, status: "skipped", attempt: 1, startedAt: 0 });
      return [];
    }

    if (outcome instanceof Error) {
      this.status.set(name, "FAILED");
      this.results.set(name, { name, status: "failed", error: outcome.message });

      const unlocked: string[] = [];

      // `continueOnError` means the failure is tolerated: the run does not fail
      // and downstream steps still run. (The Go engine parses this flag but
      // never acts on it — `handleFailure` returns either way. The platform
      // implements the behaviour the name promises, which is also Datadog's.)
      if (step.continueOnError) {
        unlocked.push(...this.unlock(name, undefined));
      }

      if (step.fallbackStepName && this.status.get(step.fallbackStepName) === "PENDING") {
        this.status.set(step.fallbackStepName, "READY");
        unlocked.push(step.fallbackStepName);
      }
      return unlocked;
    }

    const output = await this.hydrate(outcome);
    (this.context.Steps as Record<string, unknown>)[name] = output;

    this.status.set(name, "SUCCEEDED");
    this.results.set(name, {
      name,
      status: "success",
      durationMs: outcome.durationMs,
      ...(outcome.branch ? { branch: outcome.branch } : {}),
    });

    return this.unlock(name, outcome.branch);
  }

  /**
   * Follows a completed step's outbound edges and returns the steps that became
   * ready. Identical to `scheduleOutbound` in the Go scheduler: an edge naming a
   * branch is followed only when the step took that branch, an ANY gate opens on
   * the first satisfied edge, and an ALL gate waits for every inbound edge.
   */
  private unlock(name: string, branch: string | undefined): string[] {
    const node = this.graph.node(name);
    if (!node) return [];

    const unlocked: string[] = [];
    for (const edge of node.outbound) {
      if (edge.branchName !== undefined && edge.branchName !== "" && edge.branchName !== branch) {
        continue;
      }
      const target = edge.nextStepName;
      const count = (this.satisfied.get(target) ?? 0) + 1;
      this.satisfied.set(target, count);

      const threshold = this.graph.threshold(target);
      const required = threshold === "ANY" ? 1 : (this.graph.node(target)?.inboundCount ?? 1);

      if (count >= required && this.status.get(target) === "PENDING") {
        this.status.set(target, "READY");
        unlocked.push(target);
      }
    }
    return unlocked;
  }

  // ---- completion ----------------------------------------------------------

  private finish(): RunResult {
    const steps: StepResult[] = this.graph.order.map(
      (name) => this.results.get(name) ?? { name, status: "skipped" },
    );

    const failures = this.graph.order.filter((name) => {
      if (this.status.get(name) !== "FAILED") return false;
      return !this.graph.step(name)?.continueOnError;
    });

    if (failures.length > 0) {
      const first = this.results.get(failures[0]!);
      return {
        status: "failed",
        steps,
        error: `step ${failures[0]} failed: ${first?.error ?? "unknown error"}`,
      };
    }

    // Declared outputs only — the raw context never crosses the boundary.
    const declared = this.workflow.spec.outputs ?? {};
    const names = Object.keys(declared).sort();
    if (names.length === 0) return { status: "success", steps };

    const outputs: Record<string, unknown> = {};
    for (const name of names) {
      try {
        outputs[name] = resolveString(declared[name]!, this.context);
      } catch (error) {
        // A caller compiled against these names must be able to rely on them,
        // so an output that cannot be evaluated fails the run.
        return {
          status: "failed",
          steps,
          error: `evaluate output ${JSON.stringify(name)}: ${(error as Error).message}`,
        };
      }
    }
    return { status: "success", steps, outputs };
  }

  /** The run context — exposed for the runner's resume bookkeeping. */
  snapshotContext(): Record<string, unknown> {
    return JSON.parse(JSON.stringify(this.context)) as Record<string, unknown>;
  }
}

export type { StepObservation };
