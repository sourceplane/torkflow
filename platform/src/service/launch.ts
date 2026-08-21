import { ActionRegistry } from "../actions/registry.js";
import type { Env } from "../env.js";
import { newId } from "../store/ids.js";
import { createRun } from "../store/runs.js";
import { parseWorkflow, WorkflowParseError } from "../workflow/parse.js";
import { effectiveActionRef, type InputSpec, type Workflow } from "../workflow/types.js";

/**
 * Starting a run.
 *
 * Every entry point — the API, a schedule, a webhook, a replay — funnels
 * through `launchRun`. One path means the trigger surface cannot drift from
 * what the API does, and it is what makes the CLI/platform parity claim
 * testable rather than aspirational.
 */

export interface LaunchInput {
  tenantId: string;
  workflowId: string;
  /** Pin a specific version. Defaults to the workflow's live version. */
  versionId?: string;
  triggerType: "manual" | "api" | "schedule" | "webhook" | "replay";
  triggerRef?: string;
  input: Record<string, unknown>;
  resumeFrom?: string;
}

export interface LaunchResult {
  runId: string;
  instanceId: string;
  versionId: string;
}

export class LaunchError extends Error {
  readonly status: number;
  readonly detail?: unknown;
  constructor(status: number, message: string, detail?: unknown) {
    super(message);
    this.name = "LaunchError";
    this.status = status;
    this.detail = detail;
  }
}

interface VersionRow {
  id: string;
  workflow_id: string;
  digest: string;
  spec_json: string;
  source_yaml: string;
  status: string;
}

export async function resolveVersion(
  env: Env,
  tenantId: string,
  workflowId: string,
  versionId?: string,
): Promise<VersionRow> {
  if (versionId) {
    const pinned = await env.DB.prepare(
      `SELECT v.* FROM workflow_versions v
         JOIN workflows w ON w.id = v.workflow_id
        WHERE v.id = ? AND w.id = ? AND w.tenant_id = ?`,
    )
      .bind(versionId, workflowId, tenantId)
      .first<VersionRow>();
    if (!pinned) throw new LaunchError(404, `workflow version ${versionId} not found`);
    return pinned;
  }

  const live = await env.DB.prepare(
    `SELECT v.* FROM workflows w
       JOIN workflow_versions v ON v.id = w.live_version_id
      WHERE w.id = ? AND w.tenant_id = ? AND w.archived_at IS NULL`,
  )
    .bind(workflowId, tenantId)
    .first<VersionRow>();

  if (!live) {
    throw new LaunchError(
      409,
      `workflow ${workflowId} has no published version to run`,
    );
  }
  return live;
}

/**
 * Checks the trigger input against `spec.inputs`.
 *
 * The CLI accepts any `Trigger` payload and fails later, at the first step whose
 * expression cannot resolve. Declared inputs let the platform reject a bad
 * trigger before a run exists, which is what makes a run history meaningful.
 */
export function validateInputs(
  workflow: Workflow,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const declared = workflow.spec.inputs;
  if (!declared) return input;

  const resolved: Record<string, unknown> = { ...input };
  const problems: string[] = [];

  for (const name of Object.keys(declared).sort()) {
    const spec = declared[name] as InputSpec;
    const provided = resolved[name];

    if (provided === undefined || provided === null) {
      if (spec.default !== undefined) {
        resolved[name] = spec.default;
        continue;
      }
      if (spec.required) problems.push(`${name} is required`);
      continue;
    }

    if (spec.type && !matchesType(spec.type, provided)) {
      problems.push(`${name} must be of type ${spec.type}`);
    }
    if (spec.enum && !spec.enum.some((option) => option === provided)) {
      problems.push(`${name} must be one of ${JSON.stringify(spec.enum)}`);
    }
  }

  if (problems.length > 0) {
    throw new LaunchError(400, "trigger input is invalid", problems);
  }
  return resolved;
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "boolean": return typeof value === "boolean";
    case "array": return Array.isArray(value);
    case "object": return value !== null && typeof value === "object" && !Array.isArray(value);
    default: return true;
  }
}

/**
 * Rejects a workflow that references an action this deployment does not have.
 *
 * Checked at publish and again at launch, because the catalog is deployment
 * state rather than file content: a workflow valid when it was published can
 * reference an action that has since been withdrawn.
 */
export function checkActionsExist(workflow: Workflow, registry: ActionRegistry): void {
  const missing = workflow.spec.steps
    .map((step) => ({ step: step.name, actionRef: effectiveActionRef(step) }))
    .filter((entry) => !registry.has(entry.actionRef));

  if (missing.length > 0) {
    throw new LaunchError(
      422,
      "workflow references unknown actions",
      missing.map((entry) => `step ${entry.step}: unknown action ${entry.actionRef}`),
    );
  }
}

export async function launchRun(env: Env, request: LaunchInput): Promise<LaunchResult> {
  const version = await resolveVersion(env, request.tenantId, request.workflowId, request.versionId);

  let workflow: Workflow;
  try {
    workflow = parseWorkflow(version.source_yaml);
  } catch (error) {
    if (error instanceof WorkflowParseError) {
      throw new LaunchError(422, "workflow definition is invalid", error.issues);
    }
    throw error;
  }

  checkActionsExist(workflow, ActionRegistry.default());
  const input = validateInputs(workflow, request.input);

  const runId = newId("run");
  await createRun(env, {
    id: runId,
    tenantId: request.tenantId,
    workflowId: request.workflowId,
    versionId: version.id,
    triggerType: request.triggerType,
    ...(request.triggerRef ? { triggerRef: request.triggerRef } : {}),
    input,
    ...(request.resumeFrom ? { resumedFrom: request.resumeFrom } : {}),
  });

  // The run row exists before the instance does, so a failure to create the
  // instance leaves a visible queued run rather than nothing at all.
  const instance = await env.RUNNER.create({
    id: runId,
    params: {
      runId,
      tenantId: request.tenantId,
      workflowId: request.workflowId,
      versionId: version.id,
      digest: version.digest,
      spec: JSON.parse(version.spec_json),
      with: input,
      ...(request.resumeFrom ? { resumeFrom: request.resumeFrom } : {}),
    },
  });

  return { runId, instanceId: instance.id, versionId: version.id };
}
