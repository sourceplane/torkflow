APP_NAME := torkflow
APP_BIN := bin/$(APP_NAME)

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

.PHONY: help deps build provider test run clean

help:
	@echo "Targets:"
	@echo "  make deps       - Download and tidy Go modules"
	@echo "  make build      - Build engine binary"
	@echo "  make provider   - Build all action store runtime binaries"
	@echo "  make test       - Run go test ./..."
	@echo "  make run        - Run workflow (builds provider first)"
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

clean:
	rm -rf bin
	rm -f $(DEMO_PROVIDER_BIN)
	rm -f $(HTTP_PROVIDER_BIN)
	rm -f $(AI_PROVIDER_BIN)
