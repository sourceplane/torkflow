# torkflow tinx provider test steps

This verifies end-to-end provider packaging, workspace install, and execution with the current tinx workspace model.

## 1) Build `tinx` CLI (one-time)

From the repository root:

```bash
cd sourceplane/tinx
go build -o tinx ./cmd/tinx
```

## 2) Run the smoke test

```bash
cd ../torkflow
make tinx-smoke-test
```

The smoke test performs all of the following:

- packages `torkflow` from `provider.yaml`
- initializes a local tinx workspace at `.tinx-workspace`
- adds the packaged OCI layout as `torkflow`
- runs `torkflow view --workflow examples/workflow.yaml`
- runs `torkflow run --workflow examples/workflow.yaml ...`
- verifies the generated run artifacts

## 3) Inspect generated artifacts

Expected files after a successful run:

- `.tinx-artifacts/status.txt`
- `.tinx-artifacts/view.txt`
- `.tinx-artifacts/run.txt`
- `.tinx-artifacts/runs/demo-workflow/tinx-smoke-test/state.json`
- `.tinx-artifacts/runs/demo-workflow/tinx-smoke-test/context.json`
