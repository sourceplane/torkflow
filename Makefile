APP_NAME := torkflow
APP_BIN := bin/$(APP_NAME)
KIOX ?= ../kiox/kiox
KIOX_MANIFEST ?= provider.yaml
KIOX_ALIAS ?= torkflow
KIOX_WORKSPACE ?= .kiox-workspace
KIOX_OCI_DIR ?= oci
KIOX_DIST_DIR ?= dist
KIOX_ARTIFACT_DIR ?= .kiox-artifacts

DEMO_PROVIDER_SRC := ./providers/demo/cmd/demo-action
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

.PHONY: help deps build provider test run kiox-release kiox-init-workspace kiox-view kiox-run kiox-smoke-test clean

help:
	@echo "Targets:"
	@echo "  make deps       - Download and tidy Go modules"
	@echo "  make build      - Build engine binary"
	@echo "  make provider   - Build all action store runtime binaries"
	@echo "  make test       - Run go test ./..."
	@echo "  make run        - Run workflow (builds provider first)"
	@echo "  make kiox-release - Build and package torkflow as a kiox OCI provider"
	@echo "  make kiox-init-workspace - Initialize a local kiox workspace for the packaged provider"
	@echo "  make kiox-view  - Run 'view' capability via kiox"
	@echo "  make kiox-run   - Run 'run' capability via kiox"
	@echo "  make kiox-smoke-test - Package, install, and execute torkflow through kiox"
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

kiox-release:
	$(KIOX) release --manifest $(KIOX_MANIFEST) --main ./cmd/torkflow --dist $(KIOX_DIST_DIR) --output $(KIOX_OCI_DIR)

kiox-init-workspace: kiox-release
	rm -rf $(KIOX_WORKSPACE)
	$(KIOX) init $(KIOX_WORKSPACE)
	$(KIOX) --workspace $(KIOX_WORKSPACE) add $(abspath $(KIOX_OCI_DIR)) as $(KIOX_ALIAS)

kiox-view: kiox-init-workspace
	$(KIOX) --workspace $(KIOX_WORKSPACE) -- $(KIOX_ALIAS) view --workflow $(abspath $(WORKFLOW))

kiox-run: provider kiox-init-workspace
	$(KIOX) --workspace $(KIOX_WORKSPACE) -- $(KIOX_ALIAS) run --workflow $(abspath $(WORKFLOW)) --action-stores $(abspath $(ACTION_STORES)) --connections $(abspath connections.yaml) --secrets $(abspath secrets.yaml) --runs $(abspath $(RUNS)) --execution $(EXECUTION)

kiox-smoke-test:
	KIOX_BIN="$(KIOX)" bash ./scripts/smoke-kiox-provider.sh

clean:
	rm -rf bin
	rm -rf $(KIOX_DIST_DIR)
	rm -rf $(KIOX_OCI_DIR)
	rm -rf $(KIOX_WORKSPACE)
	rm -rf $(KIOX_ARTIFACT_DIR)
	rm -f $(DEMO_PROVIDER_BIN)
	rm -f $(HTTP_PROVIDER_BIN)
	rm -f $(AI_PROVIDER_BIN)
