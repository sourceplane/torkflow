# torkflow platform

The torkflow workflow engine as a hosted platform: **TypeScript end to end, on
Cloudflare, with Cloudflare Workflows as the execution substrate.** It runs
native `torkflow/v1` YAML — the same files the CLI runs — and carries no legacy
compatibility paths.

## What "no legacy" means concretely

| Dropped | Replaced by |
|---|---|
| Binary action executor (`exec.Command`, stdin/stdout JSON) | Native TypeScript actions |
| `actionStore/*/actionModule.yaml` discovery | An in-process action catalog |
| Legacy `provider.yaml` module loader | — |
| `connections.yaml` + `secrets.yaml` | D1 + envelope-encrypted credential vault |
| `.runs/` file state store | Cloudflare Workflows + D1 + R2 |
| Container / WASM action tiers | — (native only) |
| `ai.bedrock.chat` | `ai.workersai.chat`, or Bedrock via `http.request.auth` |

Two actions from the CLI's examples have no native equivalent and must be
re-pointed: `demo.echo` (a Go binary in `actionStore/demo`) and
`ai.bedrock.chat` (needs SigV4 against a long-lived AWS key pair, which is the
wrong credential to hold per tenant). `test/parity.test.ts` asserts exactly
this, so the gap is verified rather than assumed.

## Architecture

```
                    ┌────────────────────────────────────────────┐
  API / webhook ───▶│  Worker (Hono)                             │
  schedule    ───▶  │  auth · catalog · publish · launch         │
                    └───────────────┬────────────────────────────┘
                                    │ RUNNER.create()
                                    ▼
                    ┌────────────────────────────────────────────┐
                    │  Workflow instance (TorkflowRunner)        │
                    │  ┌──────────────────────────────────────┐  │
                    │  │ WorkflowDriver — deterministic        │  │
                    │  │ waves · gates · branches · retries    │  │
                    │  └───────┬──────────────────────────────┘  │
                    │   step.do│ step.sleep │ step.waitForEvent  │
                    └──────────┼────────────┼───────────────────-┘
                               ▼            ▼
                    native actions    durable hibernation
                    (core/http/ai/slack)

  D1   workflows · versions · runs · steps · connections · triggers · audit
  R2   content-addressed bundles · step payload spill
  DO   RunStream (live DAG over WebSocket) · ScheduleKeeper (one alarm/schedule)
  KV   catalog and hot-spec cache
  Q    webhook and schedule fan-in
```

### The driver is replayed — everything follows from that

Cloudflare Workflows re-runs the driver from the top after a failure or a
hibernation, serving already-completed `step.do` calls from cache. So the driver
must produce an identical sequence of step names every time. Three rules, each
one a place the Go engine would have been unsafe:

1. **No wall-clock or randomness outside a step callback.** `time.Now()` in
   `scheduler.go` moves inside `step.do`.
2. **No map-iteration order.** `dag.Graph.Roots`, `engine.StepMap` and
   `scheduler.updateState` all range over Go maps, and Go randomizes that.
   Everything here is sorted into authored step order.
3. **No concurrency beyond `Promise.all` over a deterministically-computed
   wave.** A `race` would make ordering observable.

`test/driver.test.ts` runs the same graph five times and asserts an identical
step sequence, then shares one step cache across two driver runs — Workflows'
post-eviction behaviour — and asserts nothing re-executes.

### What got better than the CLI

- **`core.sleep` → `step.sleep`.** The instance hibernates. Waiting instances
  hold no concurrency slot and sleeps do not count against the step limit, so a
  workflow can wait for days. `time.Sleep` blocks a worker for the duration.
- **`core.approval` → `step.waitForEvent`.** A durable human-in-the-loop gate
  with approve/reject branches and a timeout policy — what the CLI's contract
  reserved the `paused` status for, and what Datadog's approval step is.
- **Retries survive eviction.** `RetryStrategy` maps onto `step.do`'s retry
  config with `backoff: "linear"`, because the CLI's `baseDelay * (attempt + 1)`
  *is* linear. Default is `limit: 0` — torkflow does not retry unless asked, and
  inheriting the platform's default of five attempts would silently change every
  existing workflow.
- **`continueOnError` does what it says.** The Go engine parses the flag and
  never acts on it; here a tolerated failure keeps the run green and still
  unlocks downstream steps.
- **Typed template results.** `"{{ Steps.A.count }}"` yields the number `4`, and
  an object stays an object. The CLI formats every template through
  `fmt.Sprintf("%v", …)`, which renders a map as Go's `map[k:v]` syntax — not
  valid JSON, and unusable by a downstream action.
- **Validation at publish time.** Dangling edge references and graph cycles are
  rejected when the workflow is published. The CLI drops a dangling edge
  silently (`_ = graph.AddEdge(...)`) and hangs on a cycle.

### Expressions without `eval`

torkflow expressions are JavaScript — `{{ }}`, `core.if` conditions and
`core.js` scripts all run as JS in the CLI's goja VM. Workers forbid `eval`, so
`src/expression/` is a lexer, Pratt parser and interpreter for the subset the
language actually uses. Three properties it has that goja did not:

- **No prototype access.** `constructor`, `__proto__` and `prototype` are
  refused, closing the standard `x.constructor.constructor("…")()` escape that
  any naive property-walking evaluator opens.
- **No ambient authority.** `fetch`, `globalThis`, `Function`, `setTimeout` and
  friends are simply absent from the scope.
- **A bounded budget.** A runaway loop throws instead of hanging. The CLI's
  `expression.newVM` sets no `vm.Interrupt`, so `{{ while(true){} }}` hangs the
  engine indefinitely — harmless on a laptop, a denial of service on a shared
  runner.

It is verified against the repository's own `examples/scripts/*.js` — regex
replacement, `try`/`catch`, `JSON.parse`, template literals, fallback logic and
all.

For a script the interpreter cannot parse, the `JS_LOADER` binding (Dynamic
Workers) is configured as an isolate-backed escape hatch.

### Credentials

Envelope encryption, because Workers Secrets Store is account-scoped and this is
multi-tenant:

```
root KEK (Secrets Store)
  └── wraps a per-tenant DEK (stored wrapped in D1)
        └── AES-GCM encrypts each connection payload (ciphertext in D1)
```

Plaintext exists only in the run Worker's memory, for the duration of the step
that needs it. A step naming a connection the run was not granted fails closed —
never a fallback to a file or an environment variable — and the connection's
declared type must match what the action expects, so a Slack token cannot reach
an OpenAI step.

### The 1 MiB ceiling

Workflows caps a `step.do` return value at 1 MiB, and in torkflow step outputs
*are* the workflow context — an `http.request` against any real API will exceed
it. Results over `PAYLOAD_SPILL_BYTES` (256 KiB default) are parked in R2 and
the step returns a reference, which the driver hydrates. This is the platform
limit most likely to bite in production, so it is handled everywhere rather than
at the point it first breaks.

### Path traversal

`fromFile` and `scriptFile` resolve inside a content-addressed bundle in R2.
`normalizeBundlePath` refuses absolute paths and any `..` segment rather than
clamping it. The CLI's `resolveFromFile` cleans and joins, which lets
`fromFile: /etc/passwd` through — unremarkable on a developer's machine,
arbitrary cross-tenant file read on a shared runner.

## Layout

```
src/
  workflow/    torkflow/v1 model, parser, validation
  dag/         deterministic graph
  expression/  lexer · parser · interpreter · template resolution
  schema/      JSON Schema (draft-07 subset), no codegen
  actions/     native catalog: core, http, ai, slack
  engine/      the replay-safe driver and its ports
  store/       D1 runs, R2 bundles, credential vault, ids
  triggers/    cron parsing and next-occurrence, timezone-aware
  do/          RunStream, ScheduleKeeper
  api/         Hono control plane
  runner.ts    WorkflowEntrypoint — binds the driver to Workflows
  index.ts     fetch · queue · scheduled
migrations/    D1 schema
examples/      incident triage (approval gate), nightly report (schedule)
test/          75 tests, runnable under plain Node
```

The engine core deliberately imports no Cloudflare bindings — it talks to the
`DriverPorts` interfaces — which is why the whole of it is testable with
`vitest` and no `workerd`.

## Development

```bash
npm install
npm test              # 75 tests
npm run typecheck
npm run migrate:local
npm run dev
```

Deploying needs real resource ids in `wrangler.jsonc` (the D1 database id and KV
namespace id are placeholders), the two R2 buckets and the queue created, and
`CREDENTIAL_KEK` set to a base64 256-bit key:

```bash
npx wrangler secret put CREDENTIAL_KEK
npm run migrate:remote
npm run deploy
```

## API

```
GET    /health

GET    /v1/actions                        the catalog, for the builder's picker
POST   /v1/workflows/validate             parse + check, stores nothing
POST   /v1/workflows                      publish a version (content-addressed)
GET    /v1/workflows
GET    /v1/workflows/:id

POST   /v1/workflows/:id/runs             start a run
GET    /v1/runs                           ?status= &workflowId= &limit=
GET    /v1/runs/:id                       run + step timeline
GET    /v1/runs/:id/logs
GET    /v1/runs/:id/stream                WebSocket: live DAG
POST   /v1/runs/:id/resume                re-execute only what did not succeed

GET    /v1/approvals                      everything waiting on a human
POST   /v1/runs/:id/approvals/:step       { decision: approve | reject }

GET    /v1/connections                    metadata only, never the secret
PUT    /v1/connections/:name
DELETE /v1/connections/:name

GET    /v1/triggers
POST   /v1/workflows/:id/triggers         schedule or webhook
DELETE /v1/triggers/:id

POST   /hooks/:token                      webhook ingest (HMAC-verified, queued)
```

## Status

Built and verified: the engine, the driver and its replay semantics, the native
action catalog, expressions, cron with DST handling, the control-plane API, the
credential vault, run persistence, the live-run and schedule Durable Objects,
and webhook ingest. `wrangler deploy --dry-run` builds clean with every binding
resolved.

Not built yet: the visual builder UI, the wider integration catalog, RBAC beyond
API-key tenant scoping, and per-tenant concurrency quotas. Those are product
surface on top of a finished engine, not open engine questions.
