package main

import (
	"encoding/json"
	"fmt"
	"os"
)

type runtimeRequest struct {
	ActionRef  string         `json:"actionRef"`
	Input      map[string]any `json:"input"`
	Credential map[string]any `json:"credential,omitempty"`
}

type runtimeResponse struct {
	Status string         `json:"status"`
	Output map[string]any `json:"output,omitempty"`
	Error  string         `json:"error,omitempty"`
}

func main() {
	var req runtimeRequest
	if err := json.NewDecoder(os.Stdin).Decode(&req); err != nil {
		writeError(fmt.Errorf("decode request: %w", err))
		return
	}

	if req.ActionRef != "demo.echo" {
		writeError(fmt.Errorf("unsupported actionRef %q", req.ActionRef))
		return
	}

	text, ok := req.Input["text"].(string)
	if !ok || text == "" {
		writeError(fmt.Errorf("demo.echo requires input.text"))
		return
	}

	channel, _ := req.Input["channel"].(string)

	_ = json.NewEncoder(os.Stdout).Encode(runtimeResponse{
		Status: "success",
		Output: map[string]any{
			"sent":    true,
			"channel": channel,
			"text":    text,
		},
	})
}

func writeError(err error) {
	_ = json.NewEncoder(os.Stdout).Encode(runtimeResponse{
		Status: "error",
		Error:  err.Error(),
	})
	_, _ = fmt.Fprintf(os.Stderr, "%s\n", err)
	os.Exit(1)
}