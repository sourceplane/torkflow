package main

import (
	"encoding/json"
	"fmt"
	"os"
)

type Request struct {
	StepName    string         `json:"stepName"`
	Input       map[string]any `json:"input"`
	Connections map[string]any `json:"connections"`
}

type Response struct {
	Status string         `json:"status"`
	Output map[string]any `json:"output,omitempty"`
	Error  string         `json:"error,omitempty"`
}

func main() {
	var req Request
	if err := json.NewDecoder(os.Stdin).Decode(&req); err != nil {
		write(Response{Status: "error", Error: fmt.Sprintf("invalid input: %v", err)})
		os.Exit(1)
	}

	text, _ := req.Input["text"].(string)
	channel, _ := req.Input["channel"].(string)

	resp := Response{
		Status: "success",
		Output: map[string]any{
			"sent":    true,
			"channel": channel,
			"text":    text,
		},
	}
	write(resp)
}

func write(resp Response) {
	_ = json.NewEncoder(os.Stdout).Encode(resp)
}
