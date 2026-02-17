package executor

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os/exec"
	"time"
)

type BinaryRequest struct {
	StepName     string         `json:"stepName"`
	Input        map[string]any `json:"input"`
	Connections  map[string]any `json:"connections"`
	TimeoutSecs  int            `json:"timeoutSeconds"`
	ExecutionID  string         `json:"executionId"`
	WorkflowID   string         `json:"workflowId"`
	ProviderName string         `json:"provider"`
}

type BinaryResponse struct {
	Status string         `json:"status"`
	Output map[string]any `json:"output"`
	Error  string         `json:"error"`
	Branch string         `json:"branch"`
}

func RunBinary(entrypoint string, req BinaryRequest) (BinaryResponse, error) {
	var resp BinaryResponse
	payload, err := json.Marshal(req)
	if err != nil {
		return resp, err
	}
	cmd := exec.Command(entrypoint)
	cmd.Stdin = bytes.NewReader(payload)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err = cmd.Run()
	if err != nil {
		return resp, fmt.Errorf("binary failed: %w (%s)", err, stderr.String())
	}
	if err := json.Unmarshal(stdout.Bytes(), &resp); err != nil {
		return resp, fmt.Errorf("invalid binary output: %w", err)
	}
	return resp, nil
}

func WithTimeout(timeoutSeconds int, fn func() (BinaryResponse, error)) (BinaryResponse, error) {
	if timeoutSeconds <= 0 {
		return fn()
	}

	type result struct {
		resp BinaryResponse
		err  error
	}
	ch := make(chan result, 1)
	go func() {
		resp, err := fn()
		ch <- result{resp: resp, err: err}
	}()

	select {
	case res := <-ch:
		return res.resp, res.err
	case <-time.After(time.Duration(timeoutSeconds) * time.Second):
		return BinaryResponse{}, fmt.Errorf("binary timeout after %ds", timeoutSeconds)
	}
}
