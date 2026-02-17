package state

import "time"

type Metadata struct {
	WorkflowID  string    `json:"workflowId"`
	ExecutionID string    `json:"executionId"`
	StartedAt   time.Time `json:"startedAt"`
	Status      string    `json:"status"`
}

type State struct {
	Status            string            `json:"status"`
	CurrentReadySteps []string          `json:"currentReadySteps"`
	CompletedSteps    []string          `json:"completedSteps"`
	FailedSteps       []string          `json:"failedSteps"`
	BranchStates      map[string]string `json:"branchStates"`
	RetryStates       map[string]int    `json:"retryStates"`
}

type StepRecord struct {
	Name      string         `json:"name"`
	Status    string         `json:"status"`
	StartedAt *time.Time     `json:"startedAt,omitempty"`
	EndedAt   *time.Time     `json:"endedAt,omitempty"`
	Input     map[string]any `json:"input,omitempty"`
	Output    map[string]any `json:"output,omitempty"`
	Error     string         `json:"error,omitempty"`
	Branch    string         `json:"branch,omitempty"`
}
