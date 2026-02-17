APP_NAME := torkflow
APP_BIN := bin/$(APP_NAME)

DEMO_PROVIDER_SRC := ./examples/providers/demo/cmd/demo-action
DEMO_PROVIDER_BIN := providers/demo/demo-action
HTTP_PROVIDER_SRC := ./providers/http/cmd/http-action
HTTP_PROVIDER_BIN := providers/http/http-action

WORKFLOW ?= examples/workflow.yaml
PROVIDERS ?= providers
RUNS ?= .runs
EXECUTION ?= $(shell date -u +%Y-%m-%dT%H-%M-%S)

.PHONY: help deps build provider test run clean

help:
	@echo "Targets:"
	@echo "  make deps       - Download and tidy Go modules"
	@echo "  make build      - Build engine binary"
	@echo "  make provider   - Build all provider binaries"
	@echo "  make test       - Run go test ./..."
	@echo "  make run        - Run workflow (builds provider first)"
	@echo "  make clean      - Remove build artifacts"

deps:
	go mod tidy

build:
	mkdir -p bin
	go build -o $(APP_BIN) ./cmd/torkflow

provider:
	go build -o $(DEMO_PROVIDER_BIN) $(DEMO_PROVIDER_SRC)
	go build -o $(HTTP_PROVIDER_BIN) $(HTTP_PROVIDER_SRC)

test:
	go test ./...

run: provider build
	$(APP_BIN) --workflow $(WORKFLOW) --providers $(PROVIDERS) --runs $(RUNS) --execution $(EXECUTION)

clean:
	rm -rf bin
	rm -f $(DEMO_PROVIDER_BIN)
	rm -f $(HTTP_PROVIDER_BIN)
