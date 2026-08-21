# torkflow as a SaaS on Cloudflare

**Question:** can every feature of the `torkflow` CLI be delivered as a hosted,
Datadog-Workflows-style SaaS built on Cloudflare Workers, Workflows, Containers
and friends?

**Answer:** yes — every engine feature has a direct Cloudflare mapping, and three
of them (durable retries, sleeps, approval gates) get *better* on Cloudflare than
they are in the CLI. But it is not a lift-and-shift. Three things in the current
code are structurally incompatible with the Workers runtime and have to be
redesigned rather than ported:

1. the binary executor (`exec.Command`) — Workers cannot fork processes;
2. the scheduler (goroutines, channels, `time.Sleep`, map iteration) — Workflows
   replays the driver, so it must be deterministic and single-threaded;
3. the filesystem (state store, `fromFile`, `scriptFile`, action-store loading) —
   there is no POSIX filesystem in a Worker.

Everything else — the workflow model, the DAG semantics, the expression
resolver, connections, schema validation, `spec.outputs`, resume — carries over
essentially unchanged. Critically, the `contract/v1` backend mode already added
in WX1 is the right seam: it is the boundary a multi-tenant control plane needs,
and it means the CLI and the SaaS can execute byte-identical workflow files.

---

## 1. What the CLI is today

Inventory taken from the source, because parity is defined against this list.

| Capability | Implementation | Hosted equivalent |
|---|---|---|
| `torkflow/v1` YAML workflow model | `internal/workflow/model.go` | unchanged |
| DAG build + roots | `internal/dag/dag.go` | unchanged (with deterministic ordering) |
| Wave scheduler, `maxParallelSteps` | `internal/engine/scheduler.go` | deterministic driver inside a Workflow |
| `readinessGate.thresholdType` ALL / ANY | `scheduler.scheduleOutbound` | unchanged |
| Branch-conditional edges (`branchName`) | `scheduler.scheduleOutbound` | unchanged |
| Retry (`retry`, `errorHandlers`, linear backoff) | `engine.DetermineRetry` | `step.do` retry config |
| `fallbackStepName`, `continueOnError`, `skip` | `scheduler.handleFailure` | unchanged |
| `{{ }}` templating + JS via goja | `internal/expression/resolver.go` | QuickJS-WASM or Dynamic Worker |
| Core actions `core.if` / `core.js` / `core.sleep` / `core.stdout` | `internal/core/actions.go` | native TS; `core.sleep` → `step.sleep` |
| Binary action modules (stdin/stdout JSON) | `internal/executor/binary.go` | Containers / Sandbox SDK |
| Action registry from `actionModule.yaml` | `internal/registry/registry.go` | D1 catalog + R2 bundles |
| JSON Schema validation of input/output/credential | `internal/validation/jsonschema.go` | unchanged (Ajv) |
| Connections + file secret store | `internal/connections/` | D1 metadata + envelope-encrypted secrets |
| Injected credentials (backend mode) | `engine.ResolveCredential` | the *only* path in SaaS |
| File state store `.runs/<wf>/<exec>/` | `internal/state/filestore.go` | DO storage + R2, same `state.Store` interface |
| `spec.outputs` (WX4) | `internal/backend/backend.go` | unchanged |
| Resume (WX6) | `backend.readPriorSucceeded` | unchanged, seeded from R2 |
| `paused` status (WX7, reserved) | `contract/v1/response.schema.json` | `step.waitForEvent` |
| Live DAG view (`--view-dag`), `view` | `internal/cli/` | Durable Object + WebSocket |
| `backend` contract/v1 wire protocol | `internal/backend/backend.go` | becomes the internal run API |

---

## 2. The three blockers, and how each is resolved

### 2.1 `exec.Command` → tiered action execution

`internal/executor/binary.go:37` shells out to a provider binary and speaks JSON
over stdin/stdout. Workers have no process model, so this cannot run in an
isolate. Do **not** solve it by putting every step in a container — that is the
single largest cost driver in the whole design (see §8). Split the action
catalog into three tiers:

- **Tier 1 — native actions (target: >95% of step executions).**
  Reimplement the first-party modules (`http.*`, `core.*`, `ai.*`, Slack, and
  the integration catalog you build for Datadog parity) as TypeScript handlers
  running in the Worker itself. They keep the *exact* `actionModule.yaml`
  descriptor — same `inputSchema`, `outputSchema`, `credentialType`, `timeout`,
  `capabilities` — and the same request/response shape as `executor.BinaryRequest`
  / `BinaryResponse`. Only the transport changes: a function call instead of a
  pipe. Latency goes from ~10 ms process spawn to ~0, and cost goes to
  essentially zero.

- **Tier 2 — WASM actions.** For provider authors who want a compiled,
  sandboxed unit without a container, compile the Go provider to `GOOS=wasip1`
  and keep the stdin/stdout contract verbatim — the WASI stdio model is a
  perfect fit for the existing wire format. This is the natural evolution of
  "OCI packaging for providers" already on the README roadmap.

- **Tier 3 — container actions (BYO / legacy / heavy).**
  Run the *unmodified* Go binary. Two options: Cloudflare Containers bound to a
  Durable Object, or the Sandbox SDK, whose `exec()` starts a program from argv
  and returns a handle you collect output from — a near-literal replacement for
  `exec.Command`. This tier is what lets an existing customer's `actionStore/`
  directory run on the platform with zero rewrite, which is a real selling
  point. Bill it separately.

The `registry.ActionDescriptor` grows a `runtime.type` of `native` | `wasm` |
`container`, and `scheduler.executeStep` dispatches on it. That is the only
engine-level change the tiering requires.

### 2.2 The scheduler → a deterministic Workflow driver

Cloudflare Workflows persists the result of each `step.do` and **replays the
surrounding code** after a failure or hibernation. Steps must be deterministic
and step names must be stable and unique. The current scheduler violates this in
four places:

- `readyCh`/`sync.WaitGroup`/`sem` goroutine pool — replaced by wave-based
  `Promise.all` over `step.do`, which Workflows explicitly supports;
- `time.Sleep(50 * time.Millisecond)` polling in the `default:` branch — deleted;
  the driver is event-free and advances only on step completion;
- `time.Now().UTC()` in the driver — all timestamps move inside `step.do`;
- **map iteration order**: `dag.Graph.Roots()`, `engine.StepMap()` and
  `scheduler.updateState()` all range over Go maps. Go randomizes that order.
  Any ordering that affects which steps enter a wave, or the order of
  `Promise.all`, must be sorted. This is the subtlest of the four and the one
  most likely to produce a heisenbug under replay.

The driver shape:

```ts
export class TorkflowRunner extends WorkflowEntrypoint<Env, RunParams> {
  async run(event: WorkflowEvent<RunParams>, step: WorkflowStep) {
    // Pinned by content digest: the spec must be identical across replays.
    const spec  = parseWorkflow(await loadBundle(this.env, event.payload.specDigest));
    const graph = buildGraph(spec);                 // pure, deterministic
    let   ctx   = { Trigger: event.payload.with, Steps: {} };

    let ready = graph.roots().sort();               // sorted — replay safety
    const satisfied = new Map<string, number>();

    while (ready.length > 0) {
      const wave = ready.slice(0, spec.maxParallelSteps ?? 5);
      ready = ready.slice(wave.length);

      const results = await Promise.all(wave.map(name =>
        step.do(`step:${name}`, retryConfig(spec.steps[name]), async () => {
          const input = await resolveInput(spec.steps[name].parameters, ctx);
          return executeStep(spec.steps[name], input, ctx);   // tiered dispatch
        })
      ));

      for (const [i, r] of results.entries()) {
        ctx = applyResult(ctx, wave[i], r);         // pure
        ready = ready.concat(unlock(graph, wave[i], r.branch, satisfied)).sort();
      }
    }
    return evaluateOutputs(spec.outputs, ctx);      // WX4, unchanged
  }
}
```

Two mappings fall out for free and are strict upgrades over the CLI:

- **Retries.** Delete `engine.DetermineRetry`'s sleep loop and hand
  `RetryStrategy` to `step.do`: `{limit: maxRetries, delay: baseDelaySeconds,
  backoff: 'linear'}` — `baseDelay*(current+1)` in `engine.go` *is* linear
  backoff, so the semantics match exactly. Failures survive a Worker eviction,
  which the in-process loop does not.
- **`core.sleep`.** Becomes `step.sleep`. Sleeping instances do not count
  against the concurrency limit and sleeps do not count against the step limit,
  so a workflow can wait days without holding a slot or burning CPU. The CLI
  cannot do this at all.

And the reserved `paused` status in `contract/v1/response.schema.json` (WX7)
maps onto `step.waitForEvent` + `instance.sendEvent()` — a native durable
approval gate, which is precisely Datadog's approval step. That reservation was
a good call; it needs no contract change.

### 2.3 The filesystem → object storage

`state.Store` is already an interface (`internal/state/store.go`), so the state
store swap is clean: implement it over Durable Object storage for hot run state
plus R2 for step records and large payloads. One caveat — `internal/backend/backend.go`
currently reaches around the interface and calls `os.ReadDir`/`os.ReadFile`
directly in `collectTimeline`, `readPriorSucceeded` and `readPriorStepOutputs`.
Those three must go through `state.Store` first (adding `ListSteps()` /
`LoadStep(name)`), or the SaaS cannot reuse the backend package at all. **This
is the highest-value refactor to do in the CLI repo today** — it is small, it
improves the CLI, and it unblocks everything else.

The remaining filesystem reads need semantic decisions rather than ports:

- **`fromFile`** (`scheduler.go:441`) and **`core.js` `scriptFile`**
  (`core/actions.go`) must resolve inside a content-addressed *workflow bundle*
  in R2, not the local disk.
- **Action store loading** (`registry.LoadFromDir`) becomes a D1 catalog query
  plus R2-hosted module bundles, cached in KV.

---

## 3. Component map

| Concern | Cloudflare service |
|---|---|
| API, auth, UI serving, tier-1 actions | **Workers** (Hono) |
| One durable execution per run | **Workflows** — one instance per execution |
| Live DAG streaming, per-run coordination, per-schedule timers | **Durable Objects** (+ WebSocket Hibernation, Alarms) |
| Tier-3 / BYO binary actions | **Containers** or **Sandbox SDK** |
| Untrusted `{{ }}` and `core.js` evaluation | **Dynamic Workers** (Worker Loader binding) |
| Tenants, workflows, versions, run index, connection metadata, audit | **D1** (→ Postgres + **Hyperdrive** at scale) |
| Workflow bundles, step records, large payloads, run archive | **R2** |
| Action catalog cache, hot spec cache | **KV** |
| Webhook ingest buffering, trigger fan-out, notification delivery | **Queues** |
| Platform tick for schedules | **Cron Triggers** (→ DO Alarms per schedule) |
| `ai.*` actions, model routing, spend caps | **Workers AI** + **AI Gateway** |
| Run/step metrics for the observability panel | **Analytics Engine** |
| Reaching customer-private endpoints | **Cloudflare Tunnel** / Magic WAN |
| Per-tenant isolation of customer-authored code | **Workers for Platforms** dispatch namespaces |

### Untrusted JS is a first-class problem, not a footnote

Note that in torkflow *every* `{{ }}` is arbitrary JavaScript — `expression.Eval`
runs the template body through a goja VM. In a single-user CLI that is a
feature. In a multi-tenant SaaS it means the templating layer has the same threat
model as `core.js`, and it needs the same sandbox. Cloudflare's answer is the
Worker Loader binding (Dynamic Workers, open beta since March 2026): V8
isolates that start in ~1 ms with megabytes of memory, roughly 100× faster and
100× cheaper than a container, hardened specifically for running untrusted code.
Load the tenant's expression as a dynamic Worker with no bindings and no
outbound `fetch`, pass the context in, take the value out.

Two hardening gaps carry over from the CLI and must be closed before
multi-tenant exposure:

- **No goja interrupt.** `expression.newVM` sets no `vm.Interrupt` and no
  timeout, so `{{ while(true){} }}` hangs the engine indefinitely. In a Worker,
  a dynamic isolate has a CPU ceiling, which fixes it structurally — but the
  Go CLI should get a watchdog regardless.
- **`fromFile` path traversal.** `resolveFromFile` cleans the path and joins it
  to `workflowDir`, but neither rejects `..` nor rejects an absolute path — so
  `fromFile: /etc/passwd` reads it. On a developer's laptop that is unremarkable;
  in a hosted runner it is arbitrary file read across tenants. The bundle
  resolver must reject any path escaping the bundle root, and the CLI should
  reject absolute paths too.

---

## 4. Secrets and connections

Backend mode already establishes the right invariant: injected credentials are
the *exclusive* source and a step naming an unprovided connection fails closed
(`engine.ResolveCredential`). The SaaS keeps that exactly and never ships
`connections.yaml`/`secrets.yaml` to the runner.

Envelope encryption, since Workers Secrets Store is account-scoped and not
per-tenant:

- a root KEK in the Workers Secrets Store, rotated on a schedule;
- a per-tenant DEK, wrapped by the KEK, stored in D1;
- credential payloads encrypted with the DEK using WebCrypto AES-GCM, stored in
  D1 as ciphertext;
- decryption happens only in the run Worker, in memory, immediately before the
  `connections` map is handed to the driver — matching the contract's
  "values never persist on either side".

OAuth-based connections (needed for Datadog-style catalog parity) add a token
refresh Durable Object per connection so refreshes serialize.

---

## 5. Triggers — the Datadog parity surface

The CLI has exactly one trigger: a human typing `torkflow run`. This is the
largest *net-new* build, not a port.

| Trigger | Implementation |
|---|---|
| Manual / API | Worker route → `WORKFLOW.create()` |
| Schedule (cron) | DO Alarm per schedule (exact timing, per-tenant) with a Cron Trigger as a sweeper for missed alarms |
| Webhook | Per-tenant URL → Worker → Queue → instance creation (buffering absorbs bursts against the 100/s per-workflow creation limit) |
| Alert / monitor | Generic inbound webhook adapters (Datadog, PagerDuty, Grafana, Sentry) normalized into `Trigger` context |
| Event / chat ops | Slack/Teams slash commands and interactive callbacks |
| Sub-workflow | A workflow step that creates a child instance and awaits it |

All of them funnel into one thing: build a `contract/v1` request. That keeps a
single execution path for every entry point, which is what makes CLI/SaaS parity
testable rather than aspirational.

---

## 6. Datadog Workflows feature parity

| Datadog Workflows | torkflow today | Gap to close |
|---|---|---|
| Visual drag-drop builder | YAML only | Build a canvas that emits the same YAML — YAML stays the source of truth |
| ~1000 integration actions w/ OAuth | 4 modules | Catalog build-out; the `actionModule.yaml` descriptor already supports it |
| Triggers: schedule/webhook/monitor/manual | manual only | §5 |
| Run history + per-step input/output inspection | `.runs/` JSON + `view` | R2-backed, with the CLI's DAG view as the UI |
| Approval / human-in-the-loop steps | reserved (`paused`, WX7) | `step.waitForEvent` |
| Error handling + retry UI | full engine support | surface `retry`/`fallbackStepName`/`continueOnError` in the builder |
| Connections vault w/ team scoping | file-based | §4 + RBAC |
| Versioning, draft/publish | none | content-addressed bundles in R2; runs pin a digest |
| Concurrency + rate limits per tenant | `maxParallelSteps` only | DO-based token bucket per tenant |
| Audit log | none | D1 append-only + R2 archive |
| Notifications | none | Queues → email/Slack/webhook |

The engine is the strong half. The builder, the catalog and the trigger surface
are where the actual effort sits — and none of it is Cloudflare-specific risk.

---

## 7. Platform limits that shape the design

Verified against current Cloudflare documentation (August 2026). These are
design constraints, not blockers:

- **1 MiB max step result.** Step outputs are workflow context in torkflow, and
  an `http.request` against a large API response will exceed this. Every step
  return must be `{inline}` or `{r2Key}` with a spill threshold (~256 KiB), and
  the expression resolver must hydrate `r2Key` values lazily. **This is the
  limit most likely to bite in production** — design for it from day one.
- **10,000 steps per instance** (paid; configurable to 25,000; 1,024 free).
  Generous for a DAG, but note that retries count against it.
- **30 s CPU per step** (paid; configurable to 5 min; 10 ms free). Wall time is
  unlimited, so slow *I/O* is fine; slow *computation* is not. Long CPU-bound
  work belongs in tier 3.
- **50,000 concurrent instances** (paid), **300/s** account creation rate,
  **100/s** per workflow. Queue webhook bursts.
- **Waiting instances do not count toward concurrency** — sleeps and approval
  gates are effectively free at rest.
- **1 GB max persistent state** per instance (100 MB free).
- **30-day completed instance retention** (3 days free). Anything the product
  promises beyond 30 days must be archived to R2 by the platform, not read back
  out of Workflows.
- **Containers**: `lite` (1/16 vCPU, 256 MiB) through `standard-4` (4 vCPU,
  12 GiB); account ceilings of 1,500 vCPU / 6 TiB memory / 50 GB image storage.
- The **free tier is not a viable runtime** for this product (10 ms CPU per
  step). Price accordingly.

---

## 8. Cost model

Container pricing is $0.000020/vCPU-s (active CPU only), $0.0000025/GiB-s memory
(provisioned), with 375 vCPU-minutes and 25 GiB-hours included monthly, and
billing stops when the instance sleeps.

The tiering in §2.1 is therefore not an optimization, it is the business model.
A `basic` container (1/4 vCPU, 1 GiB) held for a 2-second HTTP call costs
roughly 100× what the same call costs as a native Worker action. Run tier 1
natively, keep containers warm and multiplexed across steps of the same run
rather than per-step, and bill tier 3 as a distinct SKU.

---

## 9. Enterprise gaps to plan for early

These are the questions that lose enterprise deals; none has a free answer:

- **Static egress IPs.** Customers allowlist source IPs for their internal APIs.
  Datadog answers this with private locations. Cloudflare's answer is Tunnel or
  Magic WAN — real product work, and the biggest architectural commitment on
  this list.
- **Data residency.** Workers execute globally. Durable Objects support
  jurisdiction restrictions (EU), D1 has regional placement — design the tenant
  record to carry a jurisdiction from the first migration, because retrofitting
  it is painful.
- **SSRF.** Tenant-authored `http.request` steps can target internal addresses.
  Workers `fetch` blocks much of this by default; container egress does not.
  Needs an explicit allow/deny policy per tenant.
- **Log retention and export.** Analytics Engine plus R2 archive; do not depend
  on Workflows' 30-day instance retention as the product's history.

---

## 10. Suggested sequencing

1. **Harden the seam in this repo.** Route `internal/backend`'s three direct
   filesystem reads through `state.Store`; add a goja interrupt; reject
   `fromFile` path escapes. Small, independently valuable, unblocks the port.
2. **Control plane.** Worker + D1 + R2: tenants, auth, workflow bundles
   (content-addressed), run index. No execution yet.
3. **Driver.** Port the scheduler to the deterministic Workflows driver with
   tier-1 native actions only. Conformance-test it against
   `contract/v1/fixtures/` — the same fixtures the CLI runs. This is the moment
   parity becomes verifiable rather than asserted.
4. **Expression sandbox.** Dynamic Workers for `{{ }}` and `core.js`.
5. **Run UI.** DO + WebSocket live DAG; port `internal/cli/dag.go`'s rendering
   to the browser.
6. **Triggers.** Manual/API → schedule → webhook → alert adapters.
7. **Tier 3.** Containers/Sandbox for BYO binaries — the "bring your existing
   `actionStore/`" story.
8. **Approvals.** `step.waitForEvent`, closing out WX7's reserved `paused`.
9. **Builder + catalog.** The long tail, and the bulk of the remaining work.

---

## 11. Bottom line

Cloudflare is a *good* fit for this specific engine, more so than a generic
container platform would be, for three reasons: Workflows gives durable
execution semantics that torkflow's file-based state store is only approximating;
sleeping and paused instances are free at rest, which is exactly the shape of
approval gates and scheduled automation; and Dynamic Workers solve the untrusted
`{{ }}`/`core.js` problem at ~1 ms and ~1 MB instead of a container per
evaluation.

The honest risks are the 1 MiB step-result ceiling (pervasive, needs designing
around everywhere), the determinism rewrite of the scheduler (subtle, especially
map ordering), static egress IPs for enterprise (a genuine product commitment),
and the sheer size of the integration catalog needed for real Datadog parity —
which is a content problem, not a platform one.

## Sources

- [Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/)
- [Workflows Workers API](https://developers.cloudflare.com/workflows/build/workers-api/)
- [Containers limits](https://developers.cloudflare.com/containers/platform-details/limits/)
- [Containers pricing](https://developers.cloudflare.com/containers/pricing/)
- [Worker Loader binding](https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/workers/runtime-apis/bindings/worker-loader.mdx)
- [Sandbox SDK](https://github.com/cloudflare/sandbox-sdk)
- [Workers for Platforms](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms)
