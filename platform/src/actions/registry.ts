import { validate } from "../schema/validate.js";
import { coreActions } from "./core.js";
import { httpActions } from "./http.js";
import { aiActions } from "./ai.js";
import { slackActions } from "./slack.js";
import type { ActionDescriptor, ActionRequest, ActionResult } from "./types.js";

/**
 * The action catalog.
 *
 * Every action is native TypeScript running in the Worker. There is no binary
 * executor and no legacy `provider.yaml` loader: an action is a descriptor plus
 * a function, registered here.
 */
export class ActionRegistry {
  private readonly actions = new Map<string, ActionDescriptor>();

  static default(): ActionRegistry {
    const registry = new ActionRegistry();
    registry.registerAll([...coreActions, ...httpActions, ...aiActions, ...slackActions]);
    return registry;
  }

  register(action: ActionDescriptor): void {
    this.actions.set(action.name, action);
  }

  registerAll(actions: ActionDescriptor[]): void {
    for (const action of actions) this.register(action);
  }

  get(actionRef: string): ActionDescriptor | undefined {
    return this.actions.get(actionRef);
  }

  has(actionRef: string): boolean {
    return this.actions.has(actionRef);
  }

  /** The catalog, sorted by name — what the builder's action picker renders. */
  list(): ActionDescriptor[] {
    return [...this.actions.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Invokes an action with its schemas enforced on both sides, mirroring the
   * order the Go scheduler validates in: input, then credential, then output.
   */
  async invoke(request: ActionRequest): Promise<ActionResult> {
    const action = this.actions.get(request.actionRef);
    if (!action) throw new Error(`unknown action ${request.actionRef}`);

    validate(action.inputSchema, request.input, `input for ${action.name}`);
    if (action.credentialSchema) {
      validate(action.credentialSchema, request.credential, `credential for ${action.name}`);
    }

    const result = await action.handler(request);

    validate(action.outputSchema, result.output, `output from ${action.name}`);
    return result;
  }
}
