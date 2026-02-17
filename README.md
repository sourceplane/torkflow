# torkflow

A thin, portable workflow orchestration runtime with a file-backed state store and pluggable binary providers.

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

## Provider contract

Provider binaries receive JSON on `stdin` and return JSON on `stdout`.

**STDIN**
```json
{
	"stepName": "Get_user_by_email",
	"input": {"email": "user@example.com"},
	"connections": {"slack": {"token": "..."}}
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
			actionId: slack.getUserByEmail
			parameters:
				email: "{{ Trigger.slack_email }}"
			outboundEdges:
				- nextStepName: Notify

		- name: Notify
			actionId: slack.postMessage
			parameters:
				channel: "{{ Trigger.slack_channel }}"
				text: "New on-call is {{ Steps.Get_current_on_call.user.email }}"
```

## Run

```
go run ./cmd/torkflow --workflow workflow.yaml --providers providers --runs .runs
```

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