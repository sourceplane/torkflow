package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"torkflow/internal/engine"
)

func main() {
	workflowPath := flag.String("workflow", "workflow.yaml", "Path to workflow YAML")
	actionStoresPath := flag.String("action-stores", "actionStore", "Path to action store directory")
	providersPath := flag.String("providers", "", "Deprecated: use --action-stores")
	connectionsPath := flag.String("connections", "connections.yaml", "Path to connection registry file")
	secretsPath := flag.String("secrets", "secrets.yaml", "Path to local secret store file")
	runsPath := flag.String("runs", ".runs", "Path to runs directory")
	executionID := flag.String("execution", time.Now().UTC().Format("2006-01-02T15-04-05"), "Execution ID")
	verbose := flag.Bool("verbose", false, "Print verbose run artifact details")
	verboseShort := flag.Bool("v", false, "Print verbose run artifact details (shorthand)")
	flag.Parse()

	if *providersPath != "" {
		*actionStoresPath = *providersPath
	}

	eng, err := engine.NewEngine(*workflowPath, *runsPath, *actionStoresPath, *connectionsPath, *secretsPath, *executionID)
	if err != nil {
		fmt.Fprintln(os.Stderr, "failed to init engine:", err)
		os.Exit(1)
	}

	runDir := filepath.Join(*runsPath, eng.WorkflowID, eng.ExecutionID)
	fmt.Printf("Starting workflow %q (execution=%s)\n", eng.WorkflowID, eng.ExecutionID)
	if *verbose || *verboseShort {
		fmt.Printf("Run artifacts: %s\n", runDir)
	}

	if err := eng.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "execution failed:", err)
		if *verbose || *verboseShort {
			fmt.Fprintf(os.Stderr, "inspect: %s\n", runDir)
		}
		os.Exit(1)
	}

	fmt.Println("Workflow completed successfully")
	if *verbose || *verboseShort {
		fmt.Printf("State: %s\n", filepath.Join(runDir, "state.json"))
		fmt.Printf("Context: %s\n", filepath.Join(runDir, "context.json"))
	}
}
