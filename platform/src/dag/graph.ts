import type { OutboundEdge, Step, Workflow } from "../workflow/types.js";

/**
 * The workflow DAG.
 *
 * Every accessor returns a deterministically ordered result. That is not
 * cosmetic: the driver runs inside a Cloudflare Workflow, which replays the
 * surrounding code after a failure or hibernation, so anything that influences
 * which steps enter a wave — and therefore the `step.do` names issued — must be
 * identical on every replay. The Go engine ranges over maps here
 * (`dag.Graph.Roots`, `engine.StepMap`), and Go randomizes map order; that is
 * safe for a single in-process run and would be a replay hazard on Workflows.
 */
export interface GraphNode {
  name: string;
  /** Outbound edges in authored order. */
  outbound: OutboundEdge[];
  /** Total inbound edge count, counting every edge including branch edges. */
  inboundCount: number;
}

export class Graph {
  readonly nodes: Map<string, GraphNode>;
  readonly steps: Map<string, Step>;
  /** Step names in authored order. */
  readonly order: string[];

  private constructor(nodes: Map<string, GraphNode>, steps: Map<string, Step>, order: string[]) {
    this.nodes = nodes;
    this.steps = steps;
    this.order = order;
  }

  static build(workflow: Workflow): Graph {
    const nodes = new Map<string, GraphNode>();
    const steps = new Map<string, Step>();
    const order: string[] = [];

    for (const step of workflow.spec.steps) {
      if (!nodes.has(step.name)) {
        nodes.set(step.name, { name: step.name, outbound: [], inboundCount: 0 });
        order.push(step.name);
      }
      steps.set(step.name, step);
    }

    for (const step of workflow.spec.steps) {
      const from = nodes.get(step.name);
      if (!from) continue;
      for (const edge of step.outboundEdges ?? []) {
        const to = nodes.get(edge.nextStepName);
        // The parser rejects dangling edges, so a miss here means the graph was
        // built from an unvalidated document; drop it as the CLI does.
        if (!to) continue;
        from.outbound.push(edge);
        to.inboundCount += 1;
      }
    }

    return new Graph(nodes, steps, order);
  }

  /** Steps with no inbound edges, in authored order. */
  roots(): string[] {
    return this.order.filter((name) => (this.nodes.get(name)?.inboundCount ?? 0) === 0);
  }

  node(name: string): GraphNode | undefined {
    return this.nodes.get(name);
  }

  step(name: string): Step | undefined {
    return this.steps.get(name);
  }

  /**
   * The readiness threshold for a step: ALL (every inbound edge) unless the
   * step declares ANY.
   */
  threshold(name: string): "ALL" | "ANY" {
    return this.steps.get(name)?.readinessGate?.thresholdType === "ANY" ? "ANY" : "ALL";
  }

  /** Sorts step names into authored order — the driver's canonical ordering. */
  sortByAuthoredOrder(names: Iterable<string>): string[] {
    const index = new Map(this.order.map((name, i) => [name, i]));
    return [...names].sort((a, b) => (index.get(a) ?? 0) - (index.get(b) ?? 0));
  }
}
