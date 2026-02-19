# torkflow

A thin, portable workflow orchestration runtime with a file-backed state store and pluggable binary action stores.

## Architecture (CNCF-grade, composable)

```
+------------------------------------------------------+
|                  Workflow Engine Core                |
|------------------------------------------------------|
| DAG Scheduler                                       |
| Execution State Machine                             |
| File State Store                                    |
| Expression Resolver ({{ }} + JS runtime)            |
| Provider Registry                                   |
| Binary Executor                                     |
| Retry & Error Manager                               |
+---------------------------+--------------------------+
														|
														v
								+--------------------------+
								|     Provider Binaries    |
								|--------------------------|
								| slack-provider           |
								| http-provider            |
								| js-provider              |
								| datastore-provider       |
								+--------------------------+
```

## File-based state

```
.runs/<workflow-id>/<execution-id>/
	metadata.json
	state.json
	context.json
	steps/
		Step_A.json
		Step_B.json
```

## Action runtime contract

Action store runtimes receive JSON on `stdin` and return JSON on `stdout`.

**STDIN**
```json
{
	"actionRef": "http.request",
	"stepName": "Get_user_by_email",
	"input": {"email": "user@example.com"},
	"credential": {"token": "..."},
	"metadata": {"workflowId": "...", "executionId": "..."}
}
```

**STDOUT**
```json
{
	"status": "success",
	"output": {"user": {"id": "U123"}}
}
```

## Example workflow

```yaml
apiVersion: torkflow/v1
kind: Workflow
metadata:
	name: sre-oncall-change
spec:
	maxParallelSteps: 5
	steps:
		- name: Get_current_on_call
			actionRef: slack.getUserByEmail
			parameters:
				email: "{{ Trigger.slack_email }}"
			outboundEdges:
				- nextStepName: Notify

		- name: Notify
			actionRef: slack.postMessage
			parameters:
				channel: "{{ Trigger.slack_channel }}"
				text: "New on-call is {{ Steps.Get_current_on_call.user.email }}"
```

## Run

```
go run ./cmd/torkflow --workflow workflow.yaml --action-stores actionStore --connections connections.yaml --secrets secrets.yaml --runs .runs
```

## Connections (local file store)

Connection metadata is stored in [connections.yaml](connections.yaml) and secrets are stored in [secrets.yaml](secrets.yaml).

Workflow steps reference connections by name:

```yaml
- name: Send_To_Slack
	actionRef: http.request.auth
	connection: slack-main
```

At runtime the engine:
- resolves connection name -> type + secretRef
- validates `connection.type` against action `credentialType`
- loads secrets from local file store
- validates credential payload against module-declared connection schema
- injects `credential` into runtime stdin

### HTTP + JS conversion example

1) Build binaries:

```
make provider build
```

2) Run:

```
./bin/torkflow --workflow examples/http-workflow.yaml
```

This workflow:
- calls `http.request` to fetch test JSON
- runs `core.js` to create a lightweight transformed payload
- uses `core.stdout` to emit the final payload to terminal stdout

### Slack message via HTTP example

Use [examples/slack-http-workflow.yaml](examples/slack-http-workflow.yaml) to:
- build advanced Slack Block Kit payloads using `ai.gemini.chat`
- parse Gemini block JSON and apply a safe fallback block template in `core.js`
- send the message via `http.request` to `chat.postMessage`

Before running, replace placeholders:
- `<SLCK_TOKEN>` (Slack bot token placeholder requested)
- `<SLACK_CHANNEL_ID>`

### AI multi-provider module example

Use [examples/ai-workflow.yaml](examples/ai-workflow.yaml) to run one workflow across:
- `ai.openai.chat`
- `ai.anthropic.chat`
- `ai.bedrock.chat`
- `ai.gemini.chat`

All actions are served by a single runtime binary in [actionStore/ai/actionModule.yaml](actionStore/ai/actionModule.yaml).

Each action keeps provider-specific input parameters while returning a unified output shape:
- `text`
- `toolCalls`
- `usage`
- `providerMetadata`

For a Gemini-only flow, use [examples/gemini-workflow.yaml](examples/gemini-workflow.yaml).

`core.stdout` supports:
- `title` (or `label`)
- `format`: `pretty` (default), `text`/`kv`, or `json`

Aliases are also available for compatibility: `core.print`, `core.stdPrint`.

## Layout

- cmd/torkflow: CLI entry
- internal/engine: scheduler + state machine
- internal/expression: Datadog-style `{{ }}` resolver with Goja
- internal/registry: provider registry loader
- internal/state: file-backed state store
- internal/executor: binary execution contract

## Next steps

- Formal JSON schema for state + context
- Provider SDK + test harness
- OCI packaging for providers