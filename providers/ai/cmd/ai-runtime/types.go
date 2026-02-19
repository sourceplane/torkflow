package main

type RuntimeRequest struct {
	ActionRef  string         `json:"actionRef"`
	StepName   string         `json:"stepName"`
	Input      map[string]any `json:"input"`
	Credential map[string]any `json:"credential"`
	Metadata   map[string]any `json:"metadata"`
}

type RuntimeResponse struct {
	Status string         `json:"status"`
	Output map[string]any `json:"output,omitempty"`
	Error  string         `json:"error,omitempty"`
}

type ProviderResult struct {
	Text     string
	Usage    Usage
	Provider map[string]any
}

type Usage struct {
	PromptTokens     int `json:"promptTokens"`
	CompletionTokens int `json:"completionTokens"`
	TotalTokens      int `json:"totalTokens"`
}
