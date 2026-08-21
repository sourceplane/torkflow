import { describe, expect, it } from "vitest";
import { WorkflowDriver } from "../src/engine/driver.js";
import { parseWorkflow } from "../src/workflow/parse.js";
import { FakeStep, makePorts, testRegistry } from "./harness.js";

function workflow(spec: string) {
  return parseWorkflow(`apiVersion: torkflow/v1\nkind: Workflow\nmetadata:\n  name: t\nspec:\n${spec}`);
}

async function run(spec: string, options: Parameters<WorkflowDriver["run"]>[0] = {}, harness = {}) {
  const ports = makePorts(harness);
  const driver = new WorkflowDriver(workflow(spec), testRegistry(), ports);
  const result = await driver.run(options);
  return { result, ports, driver };
}

describe("linear execution", () => {
  it("runs a chain and threads outputs through the context", async () => {
    const { result, ports } = await run(`
  steps:
    - name: A
      actionRef: core.js
      parameters:
        script: "({ value: 2 })"
      outboundEdges:
        - nextStepName: B
    - name: B
      actionRef: core.js
      parameters:
        script: "({ doubled: Steps.A.value * 2 })"
  outputs:
    total: "{{ Steps.B.doubled }}"
`);
    expect(result.status).toBe("success");
    expect(result.outputs).toEqual({ total: 4 });
    expect(ports.fake.sequence).toEqual(["step:A", "step:B"]);
  });

  it("returns only declared outputs, never the raw context", async () => {
    const { result } = await run(`
  steps:
    - name: A
      actionRef: core.js
      parameters:
        script: "({ secret: 'hunter2', public: 'ok' })"
  outputs:
    shown: "{{ Steps.A.public }}"
`);
    expect(result.outputs).toEqual({ shown: "ok" });
    expect(JSON.stringify(result.outputs)).not.toContain("hunter2");
  });

  it("fails the run when a declared output cannot be evaluated", async () => {
    const { result } = await run(`
  steps:
    - name: A
      actionRef: core.js
      parameters:
        script: "({ value: 1 })"
  outputs:
    broken: "{{ Steps.Missing.value }}"
`);
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/evaluate output "broken"/);
  });
});

describe("parallelism and readiness gates", () => {
  it("fans out and joins on an ALL gate", async () => {
    const { result, ports } = await run(`
  maxParallelSteps: 3
  steps:
    - name: Root
      actionRef: core.js
      parameters: { script: "({ n: 1 })" }
      outboundEdges:
        - nextStepName: L
        - nextStepName: R
    - name: L
      actionRef: core.js
      parameters: { script: "({ side: 'left' })" }
      outboundEdges: [{ nextStepName: Join }]
    - name: R
      actionRef: core.js
      parameters: { script: "({ side: 'right' })" }
      outboundEdges: [{ nextStepName: Join }]
    - name: Join
      actionRef: core.js
      readinessGate: { thresholdType: ALL }
      parameters: { script: "({ both: Steps.L.side + '+' + Steps.R.side })" }
`);
    expect(result.status).toBe("success");
    // L and R share a wave; Join only after both.
    expect(ports.fake.sequence).toEqual(["step:Root", "step:L", "step:R", "step:Join"]);
  });

  it("honours maxParallelSteps by splitting a wave", async () => {
    const { ports } = await run(`
  maxParallelSteps: 2
  steps:
    - name: Root
      actionRef: core.js
      parameters: { script: "({})" }
      outboundEdges:
        - nextStepName: A
        - nextStepName: B
        - nextStepName: C
    - name: A
      actionRef: core.js
      parameters: { script: "({})" }
    - name: B
      actionRef: core.js
      parameters: { script: "({})" }
    - name: C
      actionRef: core.js
      parameters: { script: "({})" }
`);
    expect(ports.fake.sequence).toEqual(["step:Root", "step:A", "step:B", "step:C"]);
  });

  it("opens an ANY gate on the first satisfied edge", async () => {
    const { result, ports } = await run(`
  steps:
    - name: Decide
      actionRef: core.if
      parameters: { condition: "true" }
      outboundEdges:
        - nextStepName: Yes_Path
          branchName: "true"
        - nextStepName: No_Path
          branchName: "false"
    - name: Yes_Path
      actionRef: core.js
      parameters: { script: "({ took: 'yes' })" }
      outboundEdges: [{ nextStepName: Merge }]
    - name: No_Path
      actionRef: core.js
      parameters: { script: "({ took: 'no' })" }
      outboundEdges: [{ nextStepName: Merge }]
    - name: Merge
      actionRef: core.js
      readinessGate: { thresholdType: ANY }
      parameters: { script: "({ result: Steps.Yes_Path ? 'yes' : 'no' })" }
  outputs:
    took: "{{ Steps.Merge.result }}"
`);
    expect(result.status).toBe("success");
    expect(result.outputs).toEqual({ took: "yes" });
    expect(ports.fake.sequence).toEqual(["step:Decide", "step:Yes_Path", "step:Merge"]);
    // The untaken branch is swept, not left pending.
    expect(result.steps.find((s) => s.name === "No_Path")?.status).toBe("skipped");
  });

  it("takes the false branch when the condition is false", async () => {
    const { result } = await run(`
  steps:
    - name: Decide
      actionRef: core.if
      parameters: { condition: "1 === 2" }
      outboundEdges:
        - nextStepName: Yes_Path
          branchName: "true"
        - nextStepName: No_Path
          branchName: "false"
    - name: Yes_Path
      actionRef: core.js
      parameters: { script: "({})" }
    - name: No_Path
      actionRef: core.js
      parameters: { script: "({ took: 'no' })" }
  outputs:
    took: "{{ Steps.No_Path.took }}"
`);
    expect(result.outputs).toEqual({ took: "no" });
    expect(result.steps.find((s) => s.name === "Yes_Path")?.status).toBe("skipped");
  });
});

describe("failure handling", () => {
  it("fails the run and skips everything downstream", async () => {
    const { result } = await run(`
  steps:
    - name: A
      actionRef: test.fail
      parameters: { message: "upstream exploded" }
      outboundEdges: [{ nextStepName: B }]
    - name: B
      actionRef: core.js
      parameters: { script: "({})" }
`);
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/step A failed: upstream exploded/);
    expect(result.steps.find((s) => s.name === "B")?.status).toBe("skipped");
  });

  it("continueOnError keeps the run green and still unlocks downstream steps", async () => {
    const { result } = await run(`
  steps:
    - name: A
      actionRef: test.fail
      continueOnError: true
      parameters: { message: "tolerated" }
      outboundEdges: [{ nextStepName: B }]
    - name: B
      actionRef: core.js
      parameters: { script: "({ ran: true })" }
  outputs:
    ran: "{{ Steps.B.ran }}"
`);
    expect(result.status).toBe("success");
    expect(result.outputs).toEqual({ ran: true });
    expect(result.steps.find((s) => s.name === "A")?.status).toBe("failed");
  });

  it("routes to fallbackStepName when a step fails", async () => {
    const { result } = await run(`
  steps:
    - name: A
      actionRef: test.fail
      fallbackStepName: Recover
      parameters: { message: "primary down" }
    - name: Recover
      actionRef: core.js
      parameters: { script: "({ recovered: true })" }
`);
    // The run still reports failure — the fallback ran, but A did fail.
    expect(result.status).toBe("failed");
    expect(result.steps.find((s) => s.name === "Recover")?.status).toBe("success");
  });

  it("retries according to the declared strategy, then succeeds", async () => {
    const { result, ports } = await run(`
  steps:
    - name: A
      actionRef: test.flaky
      retry:
        kind: RETRY_STRATEGY_LINEAR
        maxRetries: 3
        baseDelaySeconds: 2
      parameters: { failFor: 2 }
`);
    expect(result.status).toBe("success");
    const config = ports.fake.calls.find((c) => c.name === "step:A")?.config;
    // Linear, matching the CLI's baseDelay*(attempt+1) backoff.
    expect(config?.retries).toMatchObject({ limit: 3, delay: "2 seconds", backoff: "linear" });
  });

  it("defaults to no retries, rather than inheriting the platform default", async () => {
    const { ports } = await run(`
  steps:
    - name: A
      actionRef: core.js
      parameters: { script: "({})" }
`);
    expect(ports.fake.calls[0]?.config.retries?.limit).toBe(0);
  });

  it("accepts the errorHandlers alias for a retry strategy", async () => {
    const { ports } = await run(`
  steps:
    - name: A
      actionRef: core.js
      errorHandlers:
        - retryStrategy:
            maxRetries: 2
            baseDelaySeconds: 5
      parameters: { script: "({})" }
`);
    expect(ports.fake.calls[0]?.config.retries).toMatchObject({ limit: 2, delay: "5 seconds" });
  });
});

describe("skip expressions", () => {
  it("skips a step without consuming a workflow step", async () => {
    const { result, ports } = await run(`
  steps:
    - name: A
      actionRef: core.js
      skip: "Trigger.mode === 'dry-run'"
      parameters: { script: "({})" }
      outboundEdges: [{ nextStepName: B }]
    - name: B
      actionRef: core.js
      parameters: { script: "({})" }
`, { with: { mode: "dry-run" } });
    expect(result.steps.find((s) => s.name === "A")?.status).toBe("skipped");
    // Downstream stalls and is swept, matching the CLI.
    expect(result.steps.find((s) => s.name === "B")?.status).toBe("skipped");
    expect(ports.fake.sequence).toEqual([]);
  });

  it("runs the step when the skip expression is false", async () => {
    const { result } = await run(`
  steps:
    - name: A
      actionRef: core.js
      skip: "Trigger.mode === 'dry-run'"
      parameters: { script: "({ ran: true })" }
`, { with: { mode: "live" } });
    expect(result.steps.find((s) => s.name === "A")?.status).toBe("success");
  });
});

describe("durable sleep and approval", () => {
  it("turns core.sleep into step.sleep rather than a blocking step", async () => {
    const { result, ports } = await run(`
  steps:
    - name: Wait
      actionRef: core.sleep
      parameters: { duration: 10s }
      outboundEdges: [{ nextStepName: After }]
    - name: After
      actionRef: core.js
      parameters: { script: "({ ok: true })" }
  outputs:
    slept: "{{ Steps.Wait.duration }}"
`);
    expect(result.status).toBe("success");
    expect(ports.fake.sleeps).toEqual([{ name: "sleep:Wait", duration: 10_000 }]);
    expect(result.outputs).toEqual({ slept: "10s" });
    // No `step.do` was spent on the sleep.
    expect(ports.fake.calls.map((c) => c.name)).toEqual(["step:After"]);
  });

  it("accepts the seconds and milliseconds forms", async () => {
    const first = await run(`
  steps:
    - name: W
      actionRef: core.sleep
      parameters: { seconds: 90 }
`);
    expect(first.ports.fake.sleeps[0]?.duration).toBe(90_000);

    const second = await run(`
  steps:
    - name: W
      actionRef: core.sleep
      parameters: { milliseconds: 250 }
`);
    expect(second.ports.fake.sleeps[0]?.duration).toBe(250);
  });

  it("gates on a human decision and branches on approve", async () => {
    const fake = new FakeStep();
    fake.deliver("approval:Gate", { decision: "approve", approver: "sre@example.com" });
    const { result } = await run(`
  steps:
    - name: Gate
      actionRef: core.approval
      parameters:
        title: Deploy to production?
        approvers: [sre@example.com]
      outboundEdges:
        - nextStepName: Deploy
          branchName: approve
        - nextStepName: Abort
          branchName: reject
    - name: Deploy
      actionRef: core.js
      parameters: { script: "({ deployed: true })" }
    - name: Abort
      actionRef: core.js
      parameters: { script: "({ aborted: true })" }
  outputs:
    approver: "{{ Steps.Gate.approver }}"
`, {}, { step: fake });

    expect(result.status).toBe("success");
    expect(result.outputs).toEqual({ approver: "sre@example.com" });
    expect(result.steps.find((s) => s.name === "Deploy")?.status).toBe("success");
    expect(result.steps.find((s) => s.name === "Abort")?.status).toBe("skipped");
    expect(fake.waits[0]).toMatchObject({ name: "approval:Gate", type: "approval:Gate" });
  });

  it("takes the reject branch when the approval times out", async () => {
    const fake = new FakeStep();
    fake.timeOut("approval:Gate");
    const { result } = await run(`
  steps:
    - name: Gate
      actionRef: core.approval
      parameters: { title: Deploy? }
      outboundEdges:
        - nextStepName: Deploy
          branchName: approve
        - nextStepName: Abort
          branchName: reject
    - name: Deploy
      actionRef: core.js
      parameters: { script: "({})" }
    - name: Abort
      actionRef: core.js
      parameters: { script: "({ aborted: true })" }
  outputs:
    timedOut: "{{ Steps.Gate.timedOut }}"
`, {}, { step: fake });

    expect(result.outputs).toEqual({ timedOut: true });
    expect(result.steps.find((s) => s.name === "Abort")?.status).toBe("success");
    expect(result.steps.find((s) => s.name === "Deploy")?.status).toBe("skipped");
  });
});

describe("connections", () => {
  it("injects the granted credential", async () => {
    const { result } = await run(`
  steps:
    - name: A
      actionRef: test.needsAuth
      connection: my-conn
      parameters: {}
  outputs:
    token: "{{ Steps.A.token }}"
`, {}, { connections: { "my-conn": { token: "s3cret" } } });
    expect(result.outputs).toEqual({ token: "s3cret" });
  });

  it("fails closed when the step names a connection the run was not granted", async () => {
    const { result } = await run(`
  steps:
    - name: A
      actionRef: test.needsAuth
      connection: not-granted
      parameters: {}
`);
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/connection "not-granted" was not provided/);
  });

  it("fails when an action needs a credential and the step declares none", async () => {
    const { result } = await run(`
  steps:
    - name: A
      actionRef: test.needsAuth
      parameters: {}
`);
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/requires connection type test\.token/);
  });
});

describe("large payloads", () => {
  it("spills a step result over the threshold to the payload store", async () => {
    const { result, ports } = await run(`
  steps:
    - name: Big
      actionRef: test.big
      parameters: { size: 5000 }
      outboundEdges: [{ nextStepName: Use }]
    - name: Use
      actionRef: core.js
      parameters: { script: "({ length: Steps.Big.blob.length })" }
  outputs:
    length: "{{ Steps.Use.length }}"
`, {}, { spillBytes: 1000 });

    expect(result.status).toBe("success");
    expect(result.outputs).toEqual({ length: 5000 });
    // The step returned a reference, and the payload landed in the store.
    expect([...ports.payloads.store.keys()]).toEqual(["runs/run_test/steps/Big.json"]);
    expect(ports.fake.cache.get("step:Big")).toMatchObject({ kind: "ref" });
  });

  it("keeps small results inline", async () => {
    const { ports } = await run(`
  steps:
    - name: Small
      actionRef: test.big
      parameters: { size: 10 }
`, {}, { spillBytes: 1000 });
    expect(ports.payloads.store.size).toBe(0);
    expect(ports.fake.cache.get("step:Small")).toMatchObject({ kind: "inline" });
  });
});

describe("replay determinism", () => {
  const spec = `
  maxParallelSteps: 2
  steps:
    - name: Fetch
      actionRef: core.js
      parameters: { script: "({ id: 7 })" }
      outboundEdges:
        - nextStepName: Left
        - nextStepName: Right
    - name: Left
      actionRef: core.js
      parameters: { script: "({ v: Steps.Fetch.id * 2 })" }
      outboundEdges: [{ nextStepName: Join }]
    - name: Right
      actionRef: core.js
      parameters: { script: "({ v: Steps.Fetch.id * 3 })" }
      outboundEdges: [{ nextStepName: Join }]
    - name: Join
      actionRef: core.js
      readinessGate: { thresholdType: ALL }
      parameters: { script: "({ sum: Steps.Left.v + Steps.Right.v })" }
  outputs:
    sum: "{{ Steps.Join.sum }}"
`;

  it("issues an identical step sequence on every run", async () => {
    const sequences: string[][] = [];
    for (let i = 0; i < 5; i++) {
      const { ports } = await run(spec);
      sequences.push(ports.fake.sequence);
    }
    for (const sequence of sequences) {
      expect(sequence).toEqual(["step:Fetch", "step:Left", "step:Right", "step:Join"]);
    }
  });

  it("serves completed steps from cache when the driver is replayed", async () => {
    // One FakeStep shared across two driver runs is exactly what Workflows does
    // after an eviction: the code re-runs, completed steps come back cached.
    const fake = new FakeStep();
    const first = await run(spec, {}, { step: fake });
    expect(first.result.status).toBe("success");
    expect(fake.executed).toEqual(["step:Fetch", "step:Left", "step:Right", "step:Join"]);

    const second = await run(spec, {}, { step: fake });
    expect(second.result).toEqual(first.result);
    expect(second.ports.fake.sequence).toEqual(first.ports.fake.sequence);
    // Nothing re-executed on replay.
    expect(fake.executed).toEqual(["step:Fetch", "step:Left", "step:Right", "step:Join"]);
  });
});

describe("resume", () => {
  it("seeds succeeded steps and re-executes only the rest", async () => {
    const { result, ports } = await run(`
  steps:
    - name: A
      actionRef: core.js
      parameters: { script: "({ value: 10 })" }
      outboundEdges: [{ nextStepName: B }]
    - name: B
      actionRef: core.js
      parameters: { script: "({ doubled: Steps.A.value * 2 })" }
  outputs:
    doubled: "{{ Steps.B.doubled }}"
`, {
      seed: { completed: ["A"], outputs: { A: { value: 10 } }, branches: {} },
    });

    expect(result.status).toBe("success");
    expect(result.outputs).toEqual({ doubled: 20 });
    // A was not re-run.
    expect(ports.fake.sequence).toEqual(["step:B"]);
    expect(result.steps.find((s) => s.name === "A")?.status).toBe("skipped");
  });

  it("re-routes along the branch the prior run took", async () => {
    const { result, ports } = await run(`
  steps:
    - name: Decide
      actionRef: core.if
      parameters: { condition: "true" }
      outboundEdges:
        - nextStepName: Yes_Path
          branchName: "true"
        - nextStepName: No_Path
          branchName: "false"
    - name: Yes_Path
      actionRef: core.js
      parameters: { script: "({ took: 'yes' })" }
    - name: No_Path
      actionRef: core.js
      parameters: { script: "({ took: 'no' })" }
  outputs:
    took: "{{ Steps.Yes_Path.took }}"
`, {
      seed: {
        completed: ["Decide"],
        outputs: { Decide: { result: true } },
        branches: { Decide: "true" },
      },
    });

    expect(result.outputs).toEqual({ took: "yes" });
    expect(ports.fake.sequence).toEqual(["step:Yes_Path"]);
  });
});

describe("observability", () => {
  it("records a transition per step for the run timeline", async () => {
    const { ports } = await run(`
  steps:
    - name: A
      actionRef: core.js
      parameters: { script: "({ ok: true })" }
`);
    const statuses = ports.recorder.observations.map((o) => `${o.name}:${o.status}`);
    expect(statuses).toEqual(["A:running", "A:success"]);
  });

  it("sends core.stdout renderings to the run log", async () => {
    const { ports } = await run(`
  steps:
    - name: Print
      actionRef: core.stdout
      parameters:
        title: Report
        format: pretty
        payload:
          state: done
          count: 3
`);
    expect(ports.recorder.logs.join("\n")).toContain("╭─ Report");
    expect(ports.recorder.logs.join("\n")).toContain("• count: 3");
    expect(ports.recorder.logs.join("\n")).toContain("• state: done");
  });
});
