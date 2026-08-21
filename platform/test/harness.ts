import { ActionRegistry } from "../src/actions/registry.js";
import type { ActionDescriptor } from "../src/actions/types.js";
import type {
  ConnectionResolver,
  DriverPorts,
  DriverStep,
  PayloadStore,
  RunRecorder,
  StepConfig,
  StepObservation,
} from "../src/engine/ports.js";

/**
 * A fake `WorkflowStep` that records everything the driver asks of it and
 * caches completed steps the way Cloudflare Workflows does, so a second run
 * over the same instance exercises the replay path.
 */
export class FakeStep implements DriverStep {
  readonly calls: { name: string; config: StepConfig }[] = [];
  readonly sleeps: { name: string; duration: string | number }[] = [];
  readonly waits: { name: string; type: string; timeout?: string | number }[] = [];
  /** Names in the order the driver issued them — the replay-determinism check. */
  readonly sequence: string[] = [];
  /** Completed results, keyed by step name, surviving across `run` calls. */
  readonly cache = new Map<string, unknown>();
  /** Step names whose callback actually executed (cache misses). */
  readonly executed: string[] = [];

  private events = new Map<string, unknown>();
  private failWaits = new Set<string>();

  async do<T>(name: string, config: StepConfig, callback: () => Promise<T>): Promise<T> {
    this.sequence.push(name);
    this.calls.push({ name, config });

    if (this.cache.has(name)) return this.cache.get(name) as T;

    const limit = config.retries?.limit ?? 0;
    let lastError: unknown;
    for (let attempt = 0; attempt <= limit; attempt++) {
      try {
        this.executed.push(name);
        const result = await callback();
        this.cache.set(name, result);
        return result;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  async sleep(name: string, duration: string | number): Promise<void> {
    this.sequence.push(name);
    this.sleeps.push({ name, duration });
  }

  async waitForEvent<T>(
    name: string,
    options: { type: string; timeout?: string | number },
  ): Promise<T> {
    this.sequence.push(name);
    this.waits.push({ name, type: options.type, ...(options.timeout ? { timeout: options.timeout } : {}) });
    if (this.failWaits.has(options.type)) throw new Error("waitForEvent timed out");
    if (this.events.has(options.type)) return this.events.get(options.type) as T;
    throw new Error("waitForEvent timed out");
  }

  /** Queues the event an approval step will receive. */
  deliver(type: string, payload: unknown): void {
    this.events.set(type, { payload });
  }

  /** Makes an approval step time out instead of receiving an event. */
  timeOut(type: string): void {
    this.failWaits.add(type);
  }
}

export class MemoryPayloads implements PayloadStore {
  readonly store = new Map<string, unknown>();
  async put(key: string, value: unknown): Promise<void> {
    this.store.set(key, JSON.parse(JSON.stringify(value)));
  }
  async get(key: string): Promise<unknown> {
    if (!this.store.has(key)) throw new Error(`payload ${key} not found`);
    return this.store.get(key);
  }
}

export class MemoryRecorder implements RunRecorder {
  readonly observations: StepObservation[] = [];
  readonly logs: string[] = [];
  async step(observation: StepObservation): Promise<void> {
    this.observations.push(observation);
  }
  async log(line: string): Promise<void> {
    this.logs.push(line);
  }
}

export function connectionsFrom(map: Record<string, Record<string, unknown>>): ConnectionResolver {
  return {
    async resolve(name: string) {
      const credential = map[name];
      // Fail closed, exactly as backend mode does: a connection the caller did
      // not grant is an error, never a fallback to some other source.
      if (!credential) throw new Error(`connection ${JSON.stringify(name)} was not provided to this run`);
      return credential;
    },
  };
}

export interface HarnessOptions {
  connections?: Record<string, Record<string, unknown>>;
  spillBytes?: number;
  bundle?: Record<string, string>;
  step?: FakeStep;
}

export function makePorts(options: HarnessOptions = {}): DriverPorts & {
  fake: FakeStep;
  recorder: MemoryRecorder;
  payloads: MemoryPayloads;
} {
  const fake = options.step ?? new FakeStep();
  const recorder = new MemoryRecorder();
  const payloads = new MemoryPayloads();
  const logs: string[] = [];

  return {
    step: fake,
    recorder,
    payloads,
    connections: connectionsFrom(options.connections ?? {}),
    services: {
      log: (line: string) => {
        logs.push(line);
        void recorder.log(line);
      },
    },
    ...(options.spillBytes !== undefined ? { spillBytes: options.spillBytes } : {}),
    ...(options.bundle
      ? {
          bundle: {
            async read(path: string) {
              const content = options.bundle![path];
              if (content === undefined) throw new Error(`bundle has no file ${path}`);
              return content;
            },
          },
        }
      : {}),
    runId: "run_test",
    executionId: "exec_test",
    tenantId: "tenant_test",
    fake,
  };
}

/**
 * A registry of deterministic stand-in actions, so DAG tests never touch the
 * network. Core actions are the real ones.
 */
export function testRegistry(extra: ActionDescriptor[] = []): ActionRegistry {
  const registry = ActionRegistry.default();

  registry.register({
    name: "test.echo",
    module: "test",
    version: "1.0.0",
    description: "Return its input",
    timeoutSeconds: 10,
    handler: (request) => ({ output: { ...request.input, echoed: true } }),
  });

  registry.register({
    name: "test.fail",
    module: "test",
    version: "1.0.0",
    description: "Always fail",
    timeoutSeconds: 10,
    handler: (request) => {
      throw new Error(String(request.input.message ?? "boom"));
    },
  });

  let flakyAttempts = 0;
  registry.register({
    name: "test.flaky",
    module: "test",
    version: "1.0.0",
    description: "Fail a set number of times, then succeed",
    timeoutSeconds: 10,
    handler: (request) => {
      const failFor = Number(request.input.failFor ?? 1);
      flakyAttempts += 1;
      if (flakyAttempts <= failFor) throw new Error(`attempt ${flakyAttempts} failed`);
      return { output: { attempts: flakyAttempts } };
    },
  });

  registry.register({
    name: "test.big",
    module: "test",
    version: "1.0.0",
    description: "Return a large payload",
    timeoutSeconds: 10,
    handler: (request) => ({
      output: { blob: "x".repeat(Number(request.input.size ?? 1000)) },
    }),
  });

  registry.register({
    name: "test.needsAuth",
    module: "test",
    version: "1.0.0",
    description: "Require a credential",
    timeoutSeconds: 10,
    credentialType: "test.token",
    handler: (request) => ({ output: { token: request.credential.token ?? null } }),
  });

  registry.registerAll(extra);
  return registry;
}
