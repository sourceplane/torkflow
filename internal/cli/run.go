package cli

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"torkflow/internal/engine"
)

func runCommand(args []string) int {
	fs := flag.NewFlagSet("run", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)

	workflowPath := fs.String("workflow", "workflow.yaml", "Path to workflow YAML")
	actionStoresPath := fs.String("action-stores", "actionStore", "Path to action store directory")
	providersPath := fs.String("providers", "", "Deprecated: use --action-stores")
	connectionsPath := fs.String("connections", "connections.yaml", "Path to connection registry file")
	secretsPath := fs.String("secrets", "secrets.yaml", "Path to local secret store file")
	runsPath := fs.String("runs", ".runs", "Path to runs directory")
	executionID := fs.String("execution", time.Now().UTC().Format("2006-01-02T15-04-05"), "Execution ID")
	verbose := fs.Bool("verbose", false, "Print verbose run artifact details")
	verboseShort := fs.Bool("v", false, "Print verbose run artifact details (shorthand)")
	viewDAG := fs.Bool("view-dag", false, "Render live DAG view during execution")

	fs.Usage = func() {
		fmt.Fprintln(os.Stderr, "Usage: torkflow run [flags]")
		fs.PrintDefaults()
	}

	if err := fs.Parse(args); err != nil {
		return 2
	}

	if *providersPath != "" {
		*actionStoresPath = *providersPath
	}

	eng, err := engine.NewEngine(*workflowPath, *runsPath, *actionStoresPath, *connectionsPath, *secretsPath, *executionID)
	if err != nil {
		fmt.Fprintln(os.Stderr, "failed to init engine:", err)
		return 1
	}

	runDir := filepath.Join(*runsPath, eng.WorkflowID, eng.ExecutionID)
	fmt.Printf("Starting workflow %q (execution=%s)\n", eng.WorkflowID, eng.ExecutionID)
	if *verbose || *verboseShort {
		fmt.Printf("Run artifacts: %s\n", runDir)
	}

	err = runWithOptionalLiveDAG(eng, runDir, *viewDAG)
	if err != nil {
		fmt.Fprintln(os.Stderr, "execution failed:", err)
		if *verbose || *verboseShort {
			fmt.Fprintf(os.Stderr, "inspect: %s\n", runDir)
		}
		return 1
	}

	st, err := eng.Store.LoadState()
	if err != nil {
		fmt.Fprintln(os.Stderr, "execution failed: unable to read final state:", err)
		if *verbose || *verboseShort {
			fmt.Fprintf(os.Stderr, "inspect: %s\n", runDir)
		}
		return 1
	}
	if len(st.FailedSteps) > 0 {
		stepErrors := make([]string, 0, len(st.FailedSteps))
		for _, stepName := range st.FailedSteps {
			errMsg, readErr := loadStepError(runDir, stepName)
			if readErr != nil || errMsg == "" {
				stepErrors = append(stepErrors, fmt.Sprintf("%s: failed", stepName))
				continue
			}
			stepErrors = append(stepErrors, fmt.Sprintf("%s: %s", stepName, errMsg))
		}
		fmt.Fprintln(os.Stderr, "execution failed:", strings.Join(stepErrors, "; "))
		if *verbose || *verboseShort {
			fmt.Fprintf(os.Stderr, "State: %s\n", filepath.Join(runDir, "state.json"))
			fmt.Fprintf(os.Stderr, "Errors: %s\n", filepath.Join(runDir, "errors.log"))
		}
		return 1
	}

	fmt.Println("Workflow completed successfully")
	if *verbose || *verboseShort {
		fmt.Printf("State: %s\n", filepath.Join(runDir, "state.json"))
		fmt.Printf("Context: %s\n", filepath.Join(runDir, "context.json"))
	}

	return 0
}

func runWithOptionalLiveDAG(eng *engine.Engine, runDir string, live bool) error {
	if !live {
		return eng.Run()
	}

	errCh := make(chan error, 1)
	go func() {
		errCh <- eng.Run()
	}()

	interactive := isInteractiveTTY()
	altScreenActive := false
	if interactive {
		// Use alternate screen buffer so live refresh stays in one evolving view.
		fmt.Print("\033[?1049h\033[?25l")
		altScreenActive = true
		defer func() {
			if altScreenActive {
				fmt.Print("\033[?25h\033[?1049l")
			}
		}()
	}

	clearScreen := func() {
		fmt.Print("\033[H\033[2J")
	}

	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()

	frame := 0
	render := func() {
		if interactive {
			clearScreen()
		}
		fmt.Print(renderDAG(eng.Workflow, dagRenderOptions{RunDir: runDir, Live: true, SpinnerFrame: frame}))
	}

	render()
	for {
		select {
		case err := <-errCh:
			finalView := renderDAG(eng.Workflow, dagRenderOptions{RunDir: runDir})
			if interactive {
				clearScreen()
				fmt.Print(finalView)
				// Leave alternate screen and persist the final snapshot in primary screen.
				fmt.Print("\033[?25h\033[?1049l")
				altScreenActive = false
			}
			fmt.Print(finalView)
			if interactive {
				replayCoreStdoutOutputs(eng, runDir)
			}
			return err
		case <-ticker.C:
			frame++
			render()
		}
	}
}

func isInteractiveTTY() bool {
	info, err := os.Stdout.Stat()
	if err != nil {
		return false
	}
	return (info.Mode() & os.ModeCharDevice) != 0
}

func replayCoreStdoutOutputs(eng *engine.Engine, runDir string) {
	stdoutSteps := make([]string, 0)
	for _, step := range eng.Workflow.Spec.Steps {
		switch step.EffectiveActionRef() {
		case "core.stdout", "core.print", "core.stdPrint":
			stdoutSteps = append(stdoutSteps, step.Name)
		}
	}

	for _, stepName := range stdoutSteps {
		path := filepath.Join(runDir, "steps", stepName+".json")
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var payload struct {
			Status string         `json:"status"`
			Output map[string]any `json:"output"`
		}
		if err := json.Unmarshal(data, &payload); err != nil {
			continue
		}
		if strings.ToUpper(payload.Status) != "SUCCEEDED" {
			continue
		}
		rendered, ok := payload.Output["rendered"].(string)
		if !ok || strings.TrimSpace(rendered) == "" {
			continue
		}
		fmt.Println(rendered)
	}
}

func loadStepError(runDir string, stepName string) (string, error) {
	path := filepath.Join(runDir, "steps", stepName+".json")
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	var payload struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		return "", err
	}
	return payload.Error, nil
}
