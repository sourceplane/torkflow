package workflow

type Workflow struct {
	APIVersion string       `yaml:"apiVersion"`
	Kind       string       `yaml:"kind"`
	Metadata   Metadata     `yaml:"metadata"`
	Spec       WorkflowSpec `yaml:"spec"`
}

type Metadata struct {
	Name string `yaml:"name"`
	ID   string `yaml:"id"`
}

type WorkflowSpec struct {
	Steps            []Step         `yaml:"steps"`
	Connections      map[string]any `yaml:"connections"`
	MaxParallelSteps int            `yaml:"maxParallelSteps"`
}

type Step struct {
	Name            string            `yaml:"name"`
	ActionRef       string            `yaml:"actionRef"`
	ActionID        string            `yaml:"actionId"`
	Parameters      map[string]any    `yaml:"parameters"`
	Connection      string            `yaml:"connection"`
	OutboundEdges   []OutboundEdge    `yaml:"outboundEdges"`
	ReadinessGate   *ReadinessGate    `yaml:"readinessGate"`
	ErrorHandlers   []ErrorHandler    `yaml:"errorHandlers"`
	FallbackStep    string            `yaml:"fallbackStepName"`
	Retry           *RetryStrategy    `yaml:"retry"`
	Connections     map[string]string `yaml:"connections"`
	With            map[string]any    `yaml:"with"`
	TimeoutSeconds  int               `yaml:"timeoutSeconds"`
	SkipExpression  string            `yaml:"skip"`
	ContinueOnError bool              `yaml:"continueOnError"`
}

func (s Step) EffectiveActionRef() string {
	if s.ActionRef != "" {
		return s.ActionRef
	}
	return s.ActionID
}

type OutboundEdge struct {
	NextStepName string `yaml:"nextStepName"`
	BranchName   string `yaml:"branchName"`
}

type ReadinessGate struct {
	ThresholdType string `yaml:"thresholdType"`
}

type ErrorHandler struct {
	RetryStrategy *RetryStrategy `yaml:"retryStrategy"`
}

type RetryStrategy struct {
	Kind       string `yaml:"kind"`
	MaxRetries int    `yaml:"maxRetries"`
	BaseDelay  int    `yaml:"baseDelaySeconds"`
}
