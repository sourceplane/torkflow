package engine

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"gopkg.in/yaml.v3"

	"torkflow/internal/connections"
	"torkflow/internal/core"
	"torkflow/internal/dag"
	"torkflow/internal/registry"
	"torkflow/internal/state"
	"torkflow/internal/validation"
	"torkflow/internal/workflow"
)

type Engine struct {
	Workflow           workflow.Workflow
	WorkflowDir        string
	Graph              *dag.Graph
	Registry           *registry.Registry
	CoreRegistry       *core.Registry
	Store              state.Store
	Context            map[string]any
	ContextMu          sync.RWMutex
	MaxParallel        int
	ExecutionID        string
	WorkflowID         string
	ActionStorePath    string
	ConnectionRegistry *connections.Registry
	SecretStore        connections.SecretStore
	Validator          *validation.JSONSchemaValidator
}

func NewEngine(workflowPath string, runRoot string, actionStorePath string, connectionsPath string, secretsPath string, executionID string) (*Engine, error) {
	workflowAbsPath, err := filepath.Abs(workflowPath)
	if err != nil {
		workflowAbsPath = workflowPath
	}
	wf, err := loadWorkflow(workflowAbsPath)
	if err != nil {
		return nil, err
	}

	workflowID := wf.Metadata.ID
	if workflowID == "" {
		workflowID = wf.Metadata.Name
	}
	if workflowID == "" {
		workflowID = "workflow"
	}

	runDir := filepath.Join(runRoot, workflowID, executionID)
	store := state.NewFileStore(runDir)
	reg := registry.NewRegistry()
	if err := reg.LoadFromDir(actionStorePath); err != nil {
		return nil, err
	}
	connReg, err := connections.LoadRegistry(connectionsPath)
	if err != nil {
		return nil, err
	}
	secretStore, err := connections.LoadFileSecretStore(secretsPath)
	if err != nil {
		return nil, err
	}

	graph := buildGraph(wf)

	maxParallel := wf.Spec.MaxParallelSteps
	if maxParallel <= 0 {
		maxParallel = 5
	}

	ctx := map[string]any{
		"Trigger": map[string]any{},
		"Steps":   map[string]any{},
	}

	return &Engine{
		Workflow:           wf,
		WorkflowDir:        filepath.Dir(workflowAbsPath),
		Graph:              graph,
		Registry:           reg,
		CoreRegistry:       core.NewRegistry(),
		Store:              store,
		Context:            ctx,
		MaxParallel:        maxParallel,
		ExecutionID:        executionID,
		WorkflowID:         workflowID,
		ActionStorePath:    actionStorePath,
		ConnectionRegistry: connReg,
		SecretStore:        secretStore,
		Validator:          validation.NewJSONSchemaValidator(),
	}, nil
}

func (e *Engine) Run() error {
	if err := e.initializeState(); err != nil {
		return err
	}
	scheduler := NewScheduler(e)
	return scheduler.Run()
}

func (e *Engine) initializeState() error {
	metadata := state.Metadata{
		WorkflowID:  e.WorkflowID,
		ExecutionID: e.ExecutionID,
		StartedAt:   time.Now().UTC(),
		Status:      "running",
	}

	st := state.State{
		Status:            "running",
		CurrentReadySteps: e.Graph.Roots(),
		CompletedSteps:    []string{},
		FailedSteps:       []string{},
		BranchStates:      map[string]string{},
		RetryStates:       map[string]int{},
	}

	return e.Store.Init(metadata, st, e.Context)
}

func loadWorkflow(path string) (workflow.Workflow, error) {
	var wf workflow.Workflow
	data, err := os.ReadFile(path)
	if err != nil {
		return wf, err
	}
	if err := yaml.Unmarshal(data, &wf); err != nil {
		return wf, err
	}
	return wf, nil
}

func buildGraph(wf workflow.Workflow) *dag.Graph {
	graph := dag.NewGraph()
	for _, step := range wf.Spec.Steps {
		graph.AddNode(step.Name)
	}
	for _, step := range wf.Spec.Steps {
		for _, edge := range step.OutboundEdges {
			_ = graph.AddEdge(step.Name, edge.NextStepName, edge.BranchName)
		}
	}
	return graph
}

func (e *Engine) StepMap() map[string]workflow.Step {
	steps := map[string]workflow.Step{}
	for _, step := range e.Workflow.Spec.Steps {
		steps[step.Name] = step
	}
	return steps
}

func (e *Engine) SnapshotContext() (map[string]any, error) {
	e.ContextMu.RLock()
	defer e.ContextMu.RUnlock()

	payload, err := json.Marshal(e.Context)
	if err != nil {
		return nil, err
	}
	var clone map[string]any
	if err := json.Unmarshal(payload, &clone); err != nil {
		return nil, err
	}
	return clone, nil
}

func (e *Engine) UpdateContext(stepName string, output map[string]any) error {
	e.ContextMu.Lock()
	defer e.ContextMu.Unlock()

	steps, ok := e.Context["Steps"].(map[string]any)
	if !ok {
		steps = map[string]any{}
		e.Context["Steps"] = steps
	}
	steps[stepName] = output
	return e.Store.SaveContext(e.Context)
}

func (e *Engine) MarkBranch(stepName, branch string) error {
	st, err := e.Store.LoadState()
	if err != nil {
		return err
	}
	st.BranchStates[stepName] = branch
	return e.Store.SaveState(st)
}

func (e *Engine) StepReadinessThreshold(stepName string) string {
	step, ok := e.StepMap()[stepName]
	if !ok || step.ReadinessGate == nil || step.ReadinessGate.ThresholdType == "" {
		return "ALL"
	}
	return step.ReadinessGate.ThresholdType
}

func (e *Engine) ResolveConnections(step workflow.Step) map[string]any {
	result := map[string]any{}
	for key := range step.Connections {
		if value, ok := e.Workflow.Spec.Connections[key]; ok {
			result[key] = value
		}
	}
	return result
}

func (e *Engine) ResolveCredential(step workflow.Step, action registry.ActionDescriptor) (map[string]any, error) {
	if step.Connection == "" {
		legacy := e.ResolveConnections(step)
		if len(legacy) == 0 {
			if action.CredentialType != "" {
				return nil, fmt.Errorf("action %s requires connection type %s", action.Name, action.CredentialType)
			}
			return map[string]any{}, nil
		}
		return legacy, nil
	}

	conn, ok := e.ConnectionRegistry.Get(step.Connection)
	if !ok {
		return nil, fmt.Errorf("connection %q not found", step.Connection)
	}
	if action.CredentialType != "" && conn.Type != action.CredentialType {
		return nil, fmt.Errorf("connection %q type mismatch: got %s want %s", step.Connection, conn.Type, action.CredentialType)
	}

	credential, err := e.SecretStore.Get(conn.SecretRef)
	if err != nil {
		return nil, err
	}
	if action.CredentialSchema != nil {
		if err := e.Validator.Validate(action.CredentialSchema, credential); err != nil {
			return nil, fmt.Errorf("credential schema validation failed for %s: %w", action.Name, err)
		}
	}
	return credential, nil
}

func (e *Engine) DetermineRetry(step workflow.Step, retryState map[string]int) (bool, time.Duration) {
	strategy := step.Retry
	if strategy == nil && len(step.ErrorHandlers) > 0 {
		strategy = step.ErrorHandlers[0].RetryStrategy
	}
	if strategy == nil || strategy.MaxRetries <= 0 {
		return false, 0
	}

	current := retryState[step.Name]
	if current >= strategy.MaxRetries {
		return false, 0
	}
	delay := time.Duration(strategy.BaseDelay*(current+1)) * time.Second
	return true, delay
}

func (e *Engine) String() string {
	return fmt.Sprintf("workflow=%s execution=%s", e.WorkflowID, e.ExecutionID)
}
