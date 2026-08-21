import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ActionRegistry } from "../src/actions/registry.js";
import { Graph } from "../src/dag/graph.js";
import { WorkflowDriver } from "../src/engine/driver.js";
import { checkActionsExist, LaunchError } from "../src/service/launch.js";
import { nextRunAt } from "../src/triggers/cron.js";
import { parseWorkflow } from "../src/workflow/parse.js";
import { effectiveActionRef } from "../src/workflow/types.js";
import { makePorts, testRegistry } from "./harness.js";

const examples = join(import.meta.dirname, "..", "..", "examples");
const read = (name: string) => readFileSync(join(examples, name), "utf8");

const ALL = [
  "workflow.yaml",
  "http-workflow.yaml",
  "ai-workflow.yaml",
  "gemini-workflow.yaml",
  "slack-http-workflow.yaml",
];

describe("the repository's own workflow files", () => {
  it("parses every example without modification", () => {
    for (const name of ALL) {
      const workflow = parseWorkflow(read(name));
      expect(workflow.apiVersion).toBe("torkflow/v1");
      expect(workflow.spec.steps.length).toBeGreaterThan(0);
    }
  });

  it("builds the same DAG shape as the CLI for http-workflow.yaml", () => {
    const graph = Graph.build(parseWorkflow(read("http-workflow.yaml")));

    // Three independent fetches are the roots; everything else is reachable.
    expect(graph.roots()).toEqual(["Fetch_Todo", "Fetch_User", "Fetch_Post"]);

    // Normalize_Data joins all three fetches — an ALL gate over 3 inbound edges.
    expect(graph.node("Normalize_Data")?.inboundCount).toBe(3);
    expect(graph.threshold("Normalize_Data")).toBe("ALL");

    // Branch_Merged sits behind a core.if, so it declares an ANY gate: only one
    // of its two inbound edges will ever be satisfied.
    expect(graph.node("Branch_Merged")?.inboundCount).toBe(2);
    expect(graph.threshold("Branch_Merged")).toBe("ANY");

    // The branch edges carry their labels through.
    const decide = graph.node("Decide_Path");
    expect(decide?.outbound).toEqual([
      { nextStepName: "Notify_Done", branchName: true },
      { nextStepName: "Notify_Open", branchName: false },
    ]);
  });

  it("resolves the actionRef of every step in every example", () => {
    for (const name of ALL) {
      for (const step of parseWorkflow(read(name)).spec.steps) {
        expect(effectiveActionRef(step), `${name}:${step.name}`).not.toBe("");
      }
    }
  });

  it("serves core, http and ai steps from the native catalog", () => {
    const registry = ActionRegistry.default();
    // These three run as-is: every action they reference is native.
    for (const name of ["ai-workflow.yaml", "gemini-workflow.yaml", "slack-http-workflow.yaml"]) {
      const workflow = parseWorkflow(read(name));
      const unknown = workflow.spec.steps
        .map(effectiveActionRef)
        .filter((ref) => !registry.has(ref) && ref !== "ai.bedrock.chat");
      expect(unknown, name).toEqual([]);
    }
  });

  it("reports the two legacy binary actions that have no native replacement", () => {
    const registry = ActionRegistry.default();

    // `demo.echo` was served by a Go binary in actionStore/demo. There is no
    // binary executor here, so it has to be re-pointed at a native action.
    for (const name of ["workflow.yaml", "http-workflow.yaml"]) {
      const workflow = parseWorkflow(read(name));
      let caught: LaunchError | null = null;
      try {
        checkActionsExist(workflow, registry);
      } catch (error) {
        caught = error as LaunchError;
      }
      expect(caught, name).not.toBeNull();
      expect(JSON.stringify(caught!.detail)).toContain("demo.echo");
    }

    // `ai.bedrock.chat` needs SigV4 against a long-lived AWS key pair, which is
    // the wrong credential to hold per-tenant.
    const ai = parseWorkflow(read("ai-workflow.yaml"));
    expect(ai.spec.steps.map(effectiveActionRef)).toContain("ai.bedrock.chat");
    expect(registry.has("ai.bedrock.chat")).toBe(false);
  });
});

describe("end-to-end over a ported example", () => {
  /**
   * examples/http-workflow.yaml with its two `demo.echo` steps re-pointed at
   * `core.js` and its HTTP fetches stubbed. Everything else — the branch, the
   * ANY-gate merge, the sleep, the retry, the final report — is the original.
   */
  const ported = `
apiVersion: torkflow/v1
kind: Workflow
metadata:
  name: http-complex-orchestration
spec:
  maxParallelSteps: 4
  steps:
    - name: Fetch_Todo
      actionRef: test.json
      parameters:
        value: { id: 1, title: "delectus aut autem", completed: true, userId: 1 }
      outboundEdges: [{ nextStepName: Normalize_Data }]

    - name: Fetch_User
      actionRef: test.json
      parameters:
        value: { name: "Leanne Graham", email: "leanne@example.com" }
      outboundEdges: [{ nextStepName: Normalize_Data }]

    - name: Fetch_Post
      actionRef: test.json
      parameters:
        value: { id: 7, title: "a post title" }
      outboundEdges:
        - nextStepName: Normalize_Data
        - nextStepName: Fetch_Comments

    - name: Normalize_Data
      actionRef: core.js
      parameters:
        script: "({ todoId: Steps.Fetch_Todo.json.id, todoState: Steps.Fetch_Todo.json.completed ? 'done' : 'open', titleUpper: Steps.Fetch_Todo.json.title.toUpperCase(), userName: Steps.Fetch_User.json.name, userEmail: Steps.Fetch_User.json.email, postTitle: Steps.Fetch_Post.json.title })"
      outboundEdges: [{ nextStepName: Decide_Path }]

    - name: Fetch_Comments
      actionRef: test.json
      retry:
        kind: RETRY_STRATEGY_LINEAR
        maxRetries: 2
        baseDelaySeconds: 1
      parameters:
        value: [{ id: 1 }, { id: 2 }, { id: 3 }]
      outboundEdges: [{ nextStepName: Build_Final_Report }]

    - name: Decide_Path
      actionRef: core.if
      parameters:
        condition: "Steps.Normalize_Data.todoState === 'done'"
      outboundEdges:
        - nextStepName: Notify_Done
          branchName: "true"
        - nextStepName: Notify_Open
          branchName: "false"

    - name: Notify_Done
      actionRef: core.js
      parameters:
        script: "({ text: '\\u2705 TODO ' + Steps.Normalize_Data.todoId + ' is DONE by ' + Steps.Normalize_Data.userName })"
      outboundEdges: [{ nextStepName: Branch_Merged }]

    - name: Notify_Open
      actionRef: core.js
      parameters:
        script: "({ text: 'TODO is OPEN' })"
      outboundEdges: [{ nextStepName: Branch_Merged }]

    - name: Branch_Merged
      actionRef: core.js
      readinessGate: { thresholdType: ANY }
      parameters:
        script: "(() => { const done = Steps.Notify_Done || null; const open = Steps.Notify_Open || null; return { branch: done ? 'done' : 'open', notificationText: done ? done.text : (open ? open.text : 'none') }; })()"
      outboundEdges: [{ nextStepName: Build_Final_Report }]

    - name: Build_Final_Report
      actionRef: core.js
      parameters:
        script: "({ todoId: Steps.Normalize_Data.todoId, state: Steps.Normalize_Data.todoState, owner: Steps.Normalize_Data.userEmail, notification: Steps.Branch_Merged.notificationText, commentCount: Array.isArray(Steps.Fetch_Comments.json) ? Steps.Fetch_Comments.json.length : 0 })"
      outboundEdges: [{ nextStepName: Sleep_10s }]

    - name: Sleep_10s
      actionRef: core.sleep
      parameters: { duration: 10s }
      outboundEdges: [{ nextStepName: Print_Final_Report }]

    - name: Print_Final_Report
      actionRef: core.stdout
      parameters:
        title: Final Report
        format: pretty
        payload:
          todoId: "{{ Steps.Build_Final_Report.todoId }}"
          state: "{{ Steps.Build_Final_Report.state }}"
          owner: "{{ Steps.Build_Final_Report.owner }}"
          notification: "{{ Steps.Build_Final_Report.notification }}"
          commentCount: "{{ Steps.Build_Final_Report.commentCount }}"
  outputs:
    state: "{{ Steps.Build_Final_Report.state }}"
    commentCount: "{{ Steps.Build_Final_Report.commentCount }}"
    notification: "{{ Steps.Build_Final_Report.notification }}"
`;

  const registry = testRegistry([
    {
      name: "test.json",
      module: "test",
      version: "1.0.0",
      description: "Return a fixed JSON body, standing in for http.request",
      timeoutSeconds: 10,
      handler: (request) => ({ output: { statusCode: 200, json: request.input.value, ok: true } }),
    },
  ]);

  it("runs the whole graph and produces the declared outputs", async () => {
    const ports = makePorts();
    const driver = new WorkflowDriver(parseWorkflow(ported), registry, ports);
    const result = await driver.run();

    expect(result.status).toBe("success");
    expect(result.outputs).toEqual({
      state: "done",
      commentCount: 3,
      notification: "✅ TODO 1 is DONE by Leanne Graham",
    });

    // The untaken branch is swept rather than left hanging.
    expect(result.steps.find((s) => s.name === "Notify_Open")?.status).toBe("skipped");
    expect(result.steps.find((s) => s.name === "Notify_Done")?.status).toBe("success");

    // The sleep became a durable hibernation, not a blocked worker.
    expect(ports.fake.sleeps).toEqual([{ name: "sleep:Sleep_10s", duration: 10_000 }]);

    // The final report rendered into the run log.
    expect(ports.recorder.logs.join("\n")).toContain("╭─ Final Report");
    expect(ports.recorder.logs.join("\n")).toContain("• commentCount: 3");
  });

  it("produces an identical step sequence on every execution", async () => {
    const sequences: string[][] = [];
    for (let i = 0; i < 3; i++) {
      const ports = makePorts();
      await new WorkflowDriver(parseWorkflow(ported), registry, ports).run();
      sequences.push(ports.fake.sequence);
    }
    expect(sequences[1]).toEqual(sequences[0]);
    expect(sequences[2]).toEqual(sequences[0]);
  });
});

describe("the platform's own example workflows", () => {
  const platformExamples = join(import.meta.dirname, "..", "examples");
  const readPlatform = (name: string) => readFileSync(join(platformExamples, name), "utf8");

  it("parses and resolves every action natively", () => {
    const registry = ActionRegistry.default();
    for (const name of ["incident-triage.yaml", "nightly-report.yaml"]) {
      const workflow = parseWorkflow(readPlatform(name));
      // No legacy actions: everything these use is in the native catalog.
      expect(() => checkActionsExist(workflow, registry), name).not.toThrow();
    }
  });

  it("wires the incident-triage graph the way the file describes", () => {
    const workflow = parseWorkflow(readPlatform("incident-triage.yaml"));
    const graph = Graph.build(workflow);

    expect(graph.roots()).toEqual(["Fetch_Recent_Errors", "Fetch_Recent_Deploys"]);
    expect(graph.threshold("Summarise")).toBe("ALL");
    // Post_To_Channel is reachable three ways; ANY means the first wins.
    expect(graph.node("Post_To_Channel")?.inboundCount).toBe(3);
    expect(graph.threshold("Post_To_Channel")).toBe("ANY");

    // The approval gate branches on the decision.
    expect(graph.node("Request_Page_Approval")?.outbound).toEqual([
      { nextStepName: "Page_On_Call", branchName: "approve" },
      { nextStepName: "Post_To_Channel", branchName: "reject" },
    ]);

    expect(workflow.spec.inputs?.severity?.enum).toEqual(["sev1", "sev2", "sev3"]);
    expect(workflow.spec.triggers?.[0]?.type).toBe("webhook");
  });

  it("declares a valid schedule on nightly-report", () => {
    const workflow = parseWorkflow(readPlatform("nightly-report.yaml"));
    const trigger = workflow.spec.triggers?.[0];
    expect(trigger?.type).toBe("schedule");
    const schedule = trigger as { cron: string; timezone: string };
    expect(schedule.timezone).toBe("Europe/Berlin");
    // 07:00 Berlin on a Monday in August is 05:00 UTC.
    const next = nextRunAt(schedule.cron, new Date("2026-08-21T22:00:00Z").getTime(), schedule.timezone);
    expect(new Date(next!).toISOString()).toBe("2026-08-24T05:00:00.000Z");
  });
});
