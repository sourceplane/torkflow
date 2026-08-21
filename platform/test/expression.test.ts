import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BudgetExceededError, evaluateExpression, runScript } from "../src/expression/interpreter.js";
import { resolveParameters, resolveString } from "../src/expression/resolve.js";

const examples = join(import.meta.dirname, "..", "..", "examples");

describe("expression evaluation", () => {
  const context = {
    Trigger: { email: "ops@example.com", count: 3 },
    Steps: {
      Fetch_Todo: { json: { id: 1, title: "delectus aut autem", completed: false, userId: 1 } },
      Fetch_User: { json: { name: "Leanne Graham", email: "leanne@example.com" } },
      Fetch_Post: { json: { id: 7, title: "a post title" } },
      Fetch_Comments: { json: [{ id: 1 }, { id: 2 }] },
    },
  };

  it("reads nested step output", () => {
    expect(evaluateExpression("Steps.Fetch_Todo.json.id", context)).toBe(1);
  });

  it("evaluates the ternary and method calls used by examples/http-workflow.yaml", () => {
    expect(evaluateExpression("Steps.Fetch_Todo.json.completed ? 'done' : 'open'", context)).toBe("open");
    expect(evaluateExpression("Steps.Fetch_Todo.json.title.toUpperCase()", context)).toBe(
      "DELECTUS AUT AUTEM",
    );
  });

  it("evaluates strict equality conditions used by core.if", () => {
    expect(evaluateExpression("Steps.Fetch_Post.json.id === 7", context)).toBe(true);
    expect(evaluateExpression("Steps.Fetch_Post.json.id === 8", context)).toBe(false);
  });

  it("supports Array.isArray and length", () => {
    expect(
      evaluateExpression(
        "Array.isArray(Steps.Fetch_Comments.json) ? Steps.Fetch_Comments.json.length : 0",
        context,
      ),
    ).toBe(2);
  });

  it("supports the $ context binding", () => {
    expect(evaluateExpression("$.Trigger.email", context)).toBe("ops@example.com");
  });

  it("evaluates a bare object literal expression", () => {
    expect(evaluateExpression("({ prompt: 'hello', n: 1 + 1 })", context)).toEqual({
      prompt: "hello",
      n: 2,
    });
  });

  it("evaluates an IIFE with statements, as examples/http-workflow.yaml does", () => {
    const branchContext = { ...context, Steps: { ...context.Steps, Notify_Done: { text: "done!" } } };
    const result = evaluateExpression(
      "(() => { const done = Steps.Notify_Done || null; const open = Steps.Notify_Open || null; " +
        "return { branch: done ? 'done' : 'open', notificationText: done ? done.text : (open ? open.text : 'none') }; })()",
      branchContext,
    );
    expect(result).toEqual({ branch: "done", notificationText: "done!" });
  });

  it("supports array methods with interpreted callbacks", () => {
    expect(evaluateExpression("[1,2,3].map(n => n * 2)", {})).toEqual([2, 4, 6]);
    expect(evaluateExpression("[1,2,3,4].filter(n => n % 2 === 0).join('-')", {})).toBe("2-4");
    expect(evaluateExpression("[1,2,3].reduce((a, b) => a + b, 0)", {})).toBe(6);
  });

  it("supports template literals", () => {
    expect(evaluateExpression("`todo #${Steps.Fetch_Todo.json.id} for ${Steps.Fetch_User.json.name}`", context))
      .toBe("todo #1 for Leanne Graham");
  });

  it("supports optional chaining and nullish coalescing", () => {
    expect(evaluateExpression("Steps.Missing?.json?.id ?? 'none'", context)).toBe("none");
  });
});

describe("interpreter sandbox", () => {
  it("refuses prototype access, closing the constructor escape", () => {
    expect(() => evaluateExpression("''.constructor", {})).toThrow(/constructor/);
    expect(() => evaluateExpression("({}).__proto__", {})).toThrow(/__proto__/);
    expect(() => evaluateExpression("[].constructor.constructor('return 1')()", {})).toThrow(
      /constructor/,
    );
  });

  it("has no ambient authority", () => {
    for (const global of ["fetch", "globalThis", "process", "eval", "Function", "setTimeout", "WebSocket"]) {
      expect(() => evaluateExpression(global, {})).toThrow(/is not defined/);
    }
  });

  it("terminates a runaway loop instead of hanging", () => {
    expect(() => runScript("while (true) {}", {})).toThrow(BudgetExceededError);
  });

  it("does not let a catch block swallow the budget abort", () => {
    expect(() => runScript("try { while (true) {} } catch (e) { }", {})).toThrow(BudgetExceededError);
  });

  it("rejects assignment through prototype keys", () => {
    expect(() => runScript("const o = {}; o.__proto__ = { polluted: true }; return o;", {})).toThrow(
      /__proto__/,
    );
  });
});

describe("real example scripts from the repository", () => {
  const context = {
    Trigger: {},
    Steps: {
      Fetch_Todo: { json: { id: 1, title: "delectus aut autem", completed: false, userId: 1 } },
      Fetch_User: { json: { name: "Leanne Graham", email: "leanne@example.com" } },
      Fetch_Post: { json: { id: 7, title: "a post title" } },
      Gemini_Format_Slack_Blocks: {
        text: '```json\n[{"type":"header","text":{"type":"plain_text","text":"Hi"}}]\n```',
      },
    },
  };

  it("runs examples/scripts/gemini-prompt.js", () => {
    const source = readFileSync(join(examples, "scripts", "gemini-prompt.js"), "utf8");
    const result = runScript(source, context) as { prompt: string };
    expect(result.prompt).toContain("workflow determinism");
  });

  it("runs examples/scripts/prepare-gemini-block-prompt.js", () => {
    const source = readFileSync(join(examples, "scripts", "prepare-gemini-block-prompt.js"), "utf8");
    const result = runScript(source, context) as { prompt: string; fallback: { priority: string } };
    expect(result.prompt).toContain("todoId: 1");
    expect(result.prompt).toContain("ownerEmail: leanne@example.com");
    expect(result.fallback.priority).toBe("high");
  });

  it("runs examples/scripts/build-slack-message.js, including regex, try/catch and JSON.parse", () => {
    const source = readFileSync(join(examples, "scripts", "build-slack-message.js"), "utf8");
    const result = runScript(source, context) as { rawBody: string; preview: { blocks: unknown[] } };
    const parsed = JSON.parse(result.rawBody);
    expect(parsed.channel).toBe("C0AFET2FMNE");
    expect(parsed.blocks).toHaveLength(1);
    expect(parsed.blocks[0].type).toBe("header");
  });

  it("falls back to its own blocks when the model returns unparseable text", () => {
    const source = readFileSync(join(examples, "scripts", "build-slack-message.js"), "utf8");
    const broken = {
      ...context,
      Steps: { ...context.Steps, Gemini_Format_Slack_Blocks: { text: "not json at all" } },
    };
    const result = runScript(source, broken) as { preview: { blocks: { type: string }[] } };
    expect(result.preview.blocks).toHaveLength(4);
    expect(result.preview.blocks[0]!.type).toBe("header");
  });
});

describe("template resolution", () => {
  const context = { Trigger: { name: "ops" }, Steps: { A: { count: 4, obj: { k: "v" } } } };

  it("preserves the value's type when the string is exactly one template", () => {
    expect(resolveString("{{ Steps.A.count }}", context)).toBe(4);
    expect(resolveString("{{ Steps.A.obj }}", context)).toEqual({ k: "v" });
  });

  it("interpolates when the template is embedded in text", () => {
    expect(resolveString("count is {{ Steps.A.count }}!", context)).toBe("count is 4!");
    expect(resolveString("{{ Trigger.name }}/{{ Steps.A.count }}", context)).toBe("ops/4");
  });

  it("leaves plain strings untouched", () => {
    expect(resolveString("no templates here", context)).toBe("no templates here");
  });

  it("resolves nested parameter trees", async () => {
    const resolved = await resolveParameters(
      {
        url: "https://example.com/{{ Steps.A.count }}",
        headers: { "X-Name": "{{ Trigger.name }}" },
        items: ["{{ Steps.A.count }}", "static"],
        passthrough: 42,
      },
      context,
    );
    expect(resolved).toEqual({
      url: "https://example.com/4",
      headers: { "X-Name": "ops" },
      items: [4, "static"],
      passthrough: 42,
    });
  });

  it("reads fromFile through the bundle, and templates it when asked", async () => {
    const bundle = { read: async (p: string) => `file:${p} for {{ Trigger.name }}` };
    const resolved = await resolveParameters(
      {
        plain: { fromFile: "prompts/a.md" },
        templated: { fromFile: { path: "prompts/b.md", template: true } },
      },
      context,
      { bundle },
    );
    expect(resolved.plain).toBe("file:prompts/a.md for {{ Trigger.name }}");
    expect(resolved.templated).toBe("file:prompts/b.md for ops");
  });
});
