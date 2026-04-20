#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"

KIOX_BIN="${KIOX_BIN:-${KIOX:-kiox}}"
MANIFEST_PATH="${KIOX_MANIFEST:-provider.yaml}"
DIST_DIR="${KIOX_DIST_DIR:-dist}"
OCI_DIR="${KIOX_OCI_DIR:-oci}"
WORKSPACE_DIR="${KIOX_WORKSPACE_DIR:-.kiox-workspace}"
ARTIFACT_DIR="${KIOX_ARTIFACT_DIR:-.kiox-artifacts}"
EXECUTION_ID="${KIOX_EXECUTION_ID:-kiox-smoke-test}"
ARTIFACT_ROOT="$REPO_ROOT/$ARTIFACT_DIR"
RUNS_DIR="$ARTIFACT_ROOT/runs"
STATUS_LOG="$ARTIFACT_ROOT/status.txt"
VIEW_LOG="$ARTIFACT_ROOT/view.txt"
RUN_LOG="$ARTIFACT_ROOT/run.txt"
CONNECTIONS_FILE="$ARTIFACT_ROOT/connections.yaml"
SECRETS_FILE="$ARTIFACT_ROOT/secrets.yaml"

cd "$REPO_ROOT"

rm -rf "$DIST_DIR" "$OCI_DIR" "$WORKSPACE_DIR" "$ARTIFACT_ROOT"
mkdir -p "$ARTIFACT_ROOT"

cat >"$CONNECTIONS_FILE" <<'EOF'
connections:
  - name: demo-local
    type: demo.token
    secretRef: demo-local-secret
EOF

cat >"$SECRETS_FILE" <<'EOF'
secrets:
  demo-local-secret:
    token: demo-token
EOF

make provider

"$KIOX_BIN" release --manifest "$MANIFEST_PATH" --main ./cmd/torkflow --dist "$DIST_DIR" --output "$OCI_DIR"
"$KIOX_BIN" init "$WORKSPACE_DIR"
"$KIOX_BIN" --workspace "$WORKSPACE_DIR" add "$REPO_ROOT/$OCI_DIR" as torkflow
"$KIOX_BIN" --workspace "$WORKSPACE_DIR" status | tee "$STATUS_LOG"
"$KIOX_BIN" --workspace "$WORKSPACE_DIR" -- torkflow view --workflow "$REPO_ROOT/examples/workflow.yaml" | tee "$VIEW_LOG"
"$KIOX_BIN" --workspace "$WORKSPACE_DIR" -- torkflow run --workflow "$REPO_ROOT/examples/workflow.yaml" --action-stores "$REPO_ROOT/actionStore" --connections "$CONNECTIONS_FILE" --secrets "$SECRETS_FILE" --runs "$RUNS_DIR" --execution "$EXECUTION_ID" | tee "$RUN_LOG"

grep -q 'sourceplane/torkflow' "$STATUS_LOG"
grep -q 'Workflow DAG (advanced): demo-workflow' "$VIEW_LOG"
grep -q 'Starting workflow "demo-workflow"' "$RUN_LOG"
grep -q 'Workflow completed successfully' "$RUN_LOG"

test -f "$RUNS_DIR/demo-workflow/$EXECUTION_ID/state.json"
test -f "$RUNS_DIR/demo-workflow/$EXECUTION_ID/context.json"
test -d "$RUNS_DIR/demo-workflow/$EXECUTION_ID/steps"