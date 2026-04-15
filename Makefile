APP_NAME := torkflow
APP_BIN := bin/$(APP_NAME)
TINX ?= ../tinx/tinx
TINX_MANIFEST ?= provider.yaml
TINX_ALIAS ?= torkflow
TINX_WORKSPACE ?= .tinx-workspace
TINX_OCI_DIR ?= oci
TINX_DIST_DIR ?= dist
TINX_ARTIFACT_DIR ?= .tinx-artifacts

DEMO_PROVIDER_SRC := ./examples/providers/demo/cmd/demo-action
DEMO_PROVIDER_BIN := actionStore/demo/demo-action
HTTP_PROVIDER_SRC := ./providers/http/cmd/http-action
HTTP_PROVIDER_BIN := actionStore/http/http-action
AI_PROVIDER_SRC := ./providers/ai/cmd/ai-runtime
AI_PROVIDER_BIN := actionStore/ai/ai-runtime

WORKFLOW ?= examples/workflow.yaml
ACTION_STORES ?= actionStore
PROVIDERS ?= $(ACTION_STORES)
RUNS ?= .runs
EXECUTION ?= $(shell date -u +%Y-%m-%dT%H-%M-%S)

.PHONY: help deps build provider test run tinx-release tinx-init-workspace tinx-view tinx-run tinx-smoke-test clean

help:
	@echo "Targets:"
	@echo "  make deps       - Download and tidy Go modules"
	@echo "  make build      - Build engine binary"
	@echo "  make provider   - Build all action store runtime binaries"
	@echo "  make test       - Run go test ./..."
	@echo "  make run        - Run workflow (builds provider first)"
	@echo "  make tinx-release - Build and package torkflow as a tinx OCI provider"
	@echo "  make tinx-init-workspace - Initialize a local tinx workspace for the packaged provider"
	@echo "  make tinx-view  - Run 'view' capability via tinx"
	@echo "  make tinx-run   - Run 'run' capability via tinx"
	@echo "  make tinx-smoke-test - Package, install, and execute torkflow through tinx"
	@echo "  make clean      - Remove build artifacts"

deps:
	go mod tidy

build:
	mkdir -p bin
	go build -o $(APP_BIN) ./cmd/torkflow

provider:
	mkdir -p actionStore/demo actionStore/http actionStore/ai
	@if [ -d "$(DEMO_PROVIDER_SRC)" ]; then go build -o $(DEMO_PROVIDER_BIN) $(DEMO_PROVIDER_SRC); fi
	@if [ -d "$(HTTP_PROVIDER_SRC)" ]; then go build -o $(HTTP_PROVIDER_BIN) $(HTTP_PROVIDER_SRC); fi
	@if [ -d "$(AI_PROVIDER_SRC)" ]; then go build -o $(AI_PROVIDER_BIN) $(AI_PROVIDER_SRC); fi

test:
	go test ./...

run: provider build
	$(APP_BIN) --workflow $(WORKFLOW) --action-stores $(ACTION_STORES) --runs $(RUNS) --execution $(EXECUTION)

tinx-release:
	$(TINX) release --manifest $(TINX_MANIFEST) --main ./cmd/torkflow --dist $(TINX_DIST_DIR) --output $(TINX_OCI_DIR)

tinx-init-workspace: tinx-release
	rm -rf $(TINX_WORKSPACE)
	$(TINX) init $(TINX_WORKSPACE)
	$(TINX) --workspace $(TINX_WORKSPACE) add $(abspath $(TINX_OCI_DIR)) as $(TINX_ALIAS)

tinx-view: tinx-init-workspace
	$(TINX) --workspace $(TINX_WORKSPACE) -- $(TINX_ALIAS) view --workflow $(abspath $(WORKFLOW))

tinx-run: provider tinx-init-workspace
	$(TINX) --workspace $(TINX_WORKSPACE) -- $(TINX_ALIAS) run --workflow $(abspath $(WORKFLOW)) --action-stores $(abspath $(ACTION_STORES)) --connections $(abspath connections.yaml) --secrets $(abspath secrets.yaml) --runs $(abspath $(RUNS)) --execution $(EXECUTION)

tinx-smoke-test:
	TINX_BIN="$(TINX)" bash ./scripts/smoke-tinx-provider.sh

clean:
	rm -rf bin
	rm -rf $(TINX_DIST_DIR)
	rm -rf $(TINX_OCI_DIR)
	rm -rf $(TINX_WORKSPACE)
	rm -rf $(TINX_ARTIFACT_DIR)
	rm -f $(DEMO_PROVIDER_BIN)
	rm -f $(HTTP_PROVIDER_BIN)
	rm -f $(AI_PROVIDER_BIN)
