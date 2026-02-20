package cli

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"

	"gopkg.in/yaml.v3"

	"torkflow/internal/workflow"
)

func viewCommand(args []string) int {
	fs := flag.NewFlagSet("view", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)

	workflowPath := fs.String("workflow", "workflow.yaml", "Path to workflow YAML")
	runDir := fs.String("run-dir", "", "Optional run artifact directory for status overlay")
	runsPath := fs.String("runs", ".runs", "Runs root directory (used with --execution)")
	executionID := fs.String("execution", "", "Execution ID to auto-resolve run directory")
	executionIDShort := fs.String("e", "", "Shorthand for --execution")

	fs.Usage = func() {
		fmt.Fprintln(os.Stderr, "Usage: torkflow view --workflow <file> [--run-dir <path> | --execution <id> --runs .runs]")
		fs.PrintDefaults()
	}

	if err := fs.Parse(args); err != nil {
		return 2
	}

	wf, err := loadWorkflow(*workflowPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "failed to load workflow:", err)
		return 1
	}

	effectiveRunDir := *runDir
	effectiveExecutionID := *executionID
	if effectiveExecutionID == "" {
		effectiveExecutionID = *executionIDShort
	}
	if effectiveRunDir == "" && effectiveExecutionID != "" {
		effectiveRunDir = filepath.Join(*runsPath, workflowIdentifier(wf), effectiveExecutionID)
	}
	if effectiveRunDir == "" {
		effectiveRunDir = latestRunDir(*runsPath, workflowIdentifier(wf))
	}

	fmt.Print(renderDAG(wf, dagRenderOptions{RunDir: effectiveRunDir}))
	return 0
}

func latestRunDir(runsPath, workflowID string) string {
	workflowRunsDir := filepath.Join(runsPath, workflowID)
	entries, err := os.ReadDir(workflowRunsDir)
	if err != nil {
		return ""
	}

	executionIDs := make([]string, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		executionIDs = append(executionIDs, entry.Name())
	}
	if len(executionIDs) == 0 {
		return ""
	}

	sort.Strings(executionIDs)
	latest := executionIDs[len(executionIDs)-1]
	return filepath.Join(workflowRunsDir, latest)
}

func loadWorkflow(path string) (workflow.Workflow, error) {
	absPath, err := filepath.Abs(path)
	if err != nil {
		absPath = path
	}

	data, err := os.ReadFile(absPath)
	if err != nil {
		return workflow.Workflow{}, err
	}

	var wf workflow.Workflow
	if err := yaml.Unmarshal(data, &wf); err != nil {
		return workflow.Workflow{}, err
	}
	return wf, nil
}
