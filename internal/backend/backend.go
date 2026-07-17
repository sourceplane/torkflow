// Package backend implements torkflow's `backend` mode: the contract/v1 wire
// protocol orun (and any embedding caller) speaks to run one workflow as a
// subprocess. The schema and golden fixtures live in contract/v1/, vendored
// byte-identically in sourceplane/orun; both CIs run conformance against the
// same files. A wire change is a new contract version, never an edit to v1.
package backend

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"torkflow/internal/engine"
	"torkflow/internal/expression"
	"torkflow/internal/state"
)

// ContractV1 is the wire contract version this backend speaks.
const ContractV1 = "v1"

// Request is the contract/v1 document read from stdin.
type Request struct {
	Contract     string         `json:"contract"`
	Workflow     string         `json:"workflow"`
	With         map[string]any `json:"with,omitempty"`
	Connections  map[string]any `json:"connections,omitempty"`
	Metadata     map[string]any `json:"metadata,omitempty"`
	RunDir       string         `json:"runDir,omitempty"`
	ActionStores []string       `json:"actionStores,omitempty"`
	Resume       bool           `json:"resume,omitempty"`
}

// Response is the contract/v1 document written to stdout.
type Response struct {
	Contract string         `json:"contract"`
	Status   string         `json:"status"`
	Outputs  map[string]any `json:"outputs,omitempty"`
	Steps    []StepResult   `json:"steps,omitempty"`
	Error    string         `json:"error,omitempty"`
}

// StepResult is one step's outcome in the structured timeline.
type StepResult struct {
	Name       string `json:"name"`
	Status     string `json:"status"`
	Error      string `json:"error,omitempty"`
	DurationMs int64  `json:"durationMs,omitempty"`
}

// Run executes one backend request: decode from stdin, run the workflow with
// injected connections as the exclusive credential source, and write a
// contract/v1 response to stdout. Returns the process exit code (0 = the
// workflow succeeded; 1 = it failed or could not run — a structured response is
// written in both cases whenever possible).
func Run(stdin io.Reader, stdout io.Writer) int {
	var req Request
	if err := json.NewDecoder(stdin).Decode(&req); err != nil {
		return respond(stdout, Response{Contract: ContractV1, Status: "failed", Error: fmt.Sprintf("malformed backend request: %v", err)})
	}
	if req.Contract != ContractV1 {
		return respond(stdout, Response{Contract: ContractV1, Status: "failed",
			Error: fmt.Sprintf("unsupported contract %q (this engine speaks %q)", req.Contract, ContractV1)})
	}
	if req.Workflow == "" {
		return respond(stdout, Response{Contract: ContractV1, Status: "failed", Error: "request missing workflow"})
	}

	runsRoot := req.RunDir
	if runsRoot == "" {
		tmp, err := os.MkdirTemp("", "torkflow-backend-")
		if err != nil {
			return respond(stdout, Response{Contract: ContractV1, Status: "failed", Error: err.Error()})
		}
		defer os.RemoveAll(tmp)
		runsRoot = tmp
	}

	// The engine requires an existing action-store directory; a request that
	// names none (a core-actions-only workflow) gets an empty one.
	actionStore := firstExistingDir(req.ActionStores)
	if actionStore == "" {
		empty := filepath.Join(runsRoot, ".empty-action-store")
		if err := os.MkdirAll(empty, 0o755); err != nil {
			return respond(stdout, Response{Contract: ContractV1, Status: "failed", Error: err.Error()})
		}
		actionStore = empty
	}

	execID := time.Now().UTC().Format("2006-01-02T15-04-05.000000000")
	// Connection metadata and secrets files are deliberately not consulted:
	// injected connections are the exclusive credential source in backend mode.
	eng, err := engine.NewEngine(req.Workflow, runsRoot, actionStore, "", "", execID)
	if err != nil {
		return respond(stdout, Response{Contract: ContractV1, Status: "failed", Error: fmt.Sprintf("init engine: %v", err)})
	}
	eng.InjectedCredentials = coerceConnections(req.Connections)
	if req.With != nil {
		eng.Context["Trigger"] = req.With
	}

	// Resume (contract/v1 `resume`): seed the run with the steps that already
	// succeeded in the latest prior run under this runDir, restore their outputs
	// into the context, and re-execute only the rest. The embedding caller is
	// responsible for digest guards (same workflow, same engine).
	var seededSkipped []StepResult
	if req.Resume {
		if prior := latestRunDir(runsRoot, eng.WorkflowID, eng.ExecutionID); prior != "" {
			succeeded, branches := readPriorSucceeded(prior)
			eng.SeedCompleted = succeeded
			eng.SeedBranches = branches
			if priorSteps := readPriorStepOutputs(prior, succeeded); priorSteps != nil {
				eng.Context["Steps"] = priorSteps
			}
			for _, name := range succeeded {
				seededSkipped = append(seededSkipped, StepResult{Name: name, Status: "skipped"})
			}
		}
	}

	// In backend mode stdout belongs to the contract: exactly one Response
	// document on the writer this function was handed. Engine and core-action
	// prints go wherever the process's os.Stdout points — the CLI entrypoint
	// redirects it to stderr BEFORE any engine goroutine exists (a swap here
	// would race with the scheduler's workers under -race).
	runErr := eng.Run()

	runDir := filepath.Join(runsRoot, eng.WorkflowID, eng.ExecutionID)
	res := Response{Contract: ContractV1, Status: "success", Steps: append(seededSkipped, collectTimeline(runDir)...)}
	if runErr != nil {
		res.Status = "failed"
		res.Error = runErr.Error()
	}
	// The scheduler records step failures in the state store without returning
	// an error from Run — derive the terminal status from the sealed state, and
	// from the timeline itself, so a failed step can never read as success.
	if res.Status == "success" {
		if st, serr := eng.Store.LoadState(); serr == nil && len(st.FailedSteps) > 0 {
			res.Status = "failed"
			res.Error = fmt.Sprintf("step(s) failed: %s", strings.Join(st.FailedSteps, ", "))
		}
	}
	if res.Status == "success" {
		for _, s := range res.Steps {
			if s.Status == "failed" {
				res.Status = "failed"
				res.Error = fmt.Sprintf("step %s failed: %s", s.Name, s.Error)
				break
			}
		}
	}
	// Evaluate the workflow's declared spec.outputs against the final context.
	// ONLY declared outputs cross the boundary — never the raw context.
	if res.Status == "success" && len(eng.Workflow.Spec.Outputs) > 0 {
		outputs, oerr := evaluateOutputs(eng)
		if oerr != nil {
			res.Status = "failed"
			res.Error = oerr.Error()
		} else {
			res.Outputs = outputs
		}
	}
	return respond(stdout, res)
}

// evaluateOutputs resolves each declared output expression against the run's
// final context. A declared output that fails to evaluate fails the run —
// a caller compiled against these names must be able to rely on them.
func evaluateOutputs(eng *engine.Engine) (map[string]any, error) {
	finalCtx, err := eng.SnapshotContext()
	if err != nil {
		return nil, fmt.Errorf("snapshot context for outputs: %w", err)
	}
	out := make(map[string]any, len(eng.Workflow.Spec.Outputs))
	for name, expr := range eng.Workflow.Spec.Outputs {
		value, rerr := expression.ResolveString(expr, finalCtx)
		if rerr != nil {
			return nil, fmt.Errorf("evaluate output %q: %w", name, rerr)
		}
		out[name] = value
	}
	return out, nil
}

// respond writes the response and derives the exit code from its status.
func respond(stdout io.Writer, res Response) int {
	enc := json.NewEncoder(stdout)
	if err := enc.Encode(res); err != nil {
		fmt.Fprintln(os.Stderr, "backend: write response:", err)
		return 1
	}
	if res.Status == "success" {
		return 0
	}
	return 1
}

// coerceConnections normalizes injected payloads: each value should be an
// object; a bare scalar is wrapped as {"value": v} so a simple token still
// reaches the step as a credential map. nil in ⇒ empty map out — backend mode
// always runs with injected credentials as the exclusive source, so a workflow
// whose steps declare connections fails closed rather than reading files.
func coerceConnections(raw map[string]any) map[string]map[string]any {
	out := make(map[string]map[string]any, len(raw))
	for name, payload := range raw {
		if m, ok := payload.(map[string]any); ok {
			out[name] = m
			continue
		}
		out[name] = map[string]any{"value": payload}
	}
	return out
}

func firstExistingDir(dirs []string) string {
	for _, d := range dirs {
		if info, err := os.Stat(d); err == nil && info.IsDir() {
			return d
		}
	}
	return ""
}

// latestRunDir returns the newest prior run directory for the workflow under
// runsRoot, excluding the current execution. Execution ids are UTC timestamps,
// so lexical order is chronological.
func latestRunDir(runsRoot, workflowID, currentExecID string) string {
	entries, err := os.ReadDir(filepath.Join(runsRoot, workflowID))
	if err != nil {
		return ""
	}
	latest := ""
	for _, e := range entries {
		if !e.IsDir() || e.Name() == currentExecID {
			continue
		}
		if e.Name() > latest {
			latest = e.Name()
		}
	}
	if latest == "" {
		return ""
	}
	return filepath.Join(runsRoot, workflowID, latest)
}

// readPriorSucceeded reads a prior run's step records and returns the names of
// steps that SUCCEEDED (never SKIPPED — a step skipped because of an upstream
// failure must re-run on resume) plus the branches they took.
func readPriorSucceeded(runDir string) ([]string, map[string]string) {
	entries, err := os.ReadDir(filepath.Join(runDir, "steps"))
	if err != nil {
		return nil, nil
	}
	var succeeded []string
	branches := map[string]string{}
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".json" {
			continue
		}
		data, rerr := os.ReadFile(filepath.Join(runDir, "steps", e.Name()))
		if rerr != nil {
			continue
		}
		var rec state.StepRecord
		if json.Unmarshal(data, &rec) != nil {
			continue
		}
		if rec.Status == "SUCCEEDED" {
			succeeded = append(succeeded, rec.Name)
			if rec.Branch != "" {
				branches[rec.Name] = rec.Branch
			}
		}
	}
	return succeeded, branches
}

// readPriorStepOutputs restores the succeeded steps' outputs from the prior
// run's context, so downstream expressions resolve on resume.
func readPriorStepOutputs(runDir string, succeeded []string) map[string]any {
	data, err := os.ReadFile(filepath.Join(runDir, "context.json"))
	if err != nil {
		return nil
	}
	var ctx map[string]any
	if json.Unmarshal(data, &ctx) != nil {
		return nil
	}
	priorSteps, ok := ctx["Steps"].(map[string]any)
	if !ok {
		return nil
	}
	out := map[string]any{}
	for _, name := range succeeded {
		if v, ok := priorSteps[name]; ok {
			out[name] = v
		}
	}
	return out
}

// collectTimeline reads the run's per-step records and maps them onto the
// contract's step results, ordered by start time.
func collectTimeline(runDir string) []StepResult {
	entries, err := os.ReadDir(filepath.Join(runDir, "steps"))
	if err != nil {
		return nil
	}
	type timed struct {
		res   StepResult
		start time.Time
	}
	var steps []timed
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".json" {
			continue
		}
		data, rerr := os.ReadFile(filepath.Join(runDir, "steps", e.Name()))
		if rerr != nil {
			continue
		}
		var rec state.StepRecord
		if json.Unmarshal(data, &rec) != nil {
			continue
		}
		sr := StepResult{Name: rec.Name, Status: mapStatus(rec.Status), Error: rec.Error}
		var start time.Time
		if rec.StartedAt != nil {
			start = *rec.StartedAt
			if rec.EndedAt != nil {
				sr.DurationMs = rec.EndedAt.Sub(*rec.StartedAt).Milliseconds()
			}
		}
		steps = append(steps, timed{res: sr, start: start})
	}
	for i := 1; i < len(steps); i++ {
		for j := i; j > 0 && steps[j].start.Before(steps[j-1].start); j-- {
			steps[j], steps[j-1] = steps[j-1], steps[j]
		}
	}
	out := make([]StepResult, 0, len(steps))
	for _, s := range steps {
		out = append(out, s.res)
	}
	return out
}

// mapStatus converts the engine's step states to the contract's vocabulary.
func mapStatus(s string) string {
	switch s {
	case "SUCCEEDED":
		return "success"
	case "FAILED":
		return "failed"
	case "SKIPPED":
		return "skipped"
	default:
		return "failed"
	}
}
