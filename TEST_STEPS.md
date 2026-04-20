# torkflow kiox provider test steps

This verifies end-to-end provider packaging, workspace install, and execution with the current kiox workspace model.

## 1) Build `kiox` CLI (one-time)

From the repository root:

```bash
cd sourceplane/kiox
go build -o kiox ./cmd/kiox
```

## 2) Run the smoke test

```bash
cd ../torkflow
make kiox-smoke-test
```

The smoke test performs all of the following:

- packages `torkflow` from `provider.yaml`
- initializes a local kiox workspace at `.kiox-workspace`
- adds the packaged OCI layout as `torkflow`
- runs `torkflow view --workflow examples/workflow.yaml`
- runs `torkflow run --workflow examples/workflow.yaml ...`
- verifies the generated run artifacts

## 3) Inspect generated artifacts

Expected files after a successful run:

- `.kiox-artifacts/status.txt`
- `.kiox-artifacts/view.txt`
- `.kiox-artifacts/run.txt`
- `.kiox-artifacts/runs/demo-workflow/kiox-smoke-test/state.json`
- `.kiox-artifacts/runs/demo-workflow/kiox-smoke-test/context.json`
