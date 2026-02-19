package executor

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os/exec"
	"time"
)

type BinaryRequest struct {
	ActionRef    string         `json:"actionRef"`
	StepName     string         `json:"stepName"`
	Input        map[string]any `json:"input"`
	Credential   map[string]any `json:"credential,omitempty"`
	Metadata     map[string]any `json:"metadata,omitempty"`
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
		// Providers may intentionally return rich error payload on stdout with non-zero exit.
		if len(stdout.Bytes()) > 0 {
			var providerResp BinaryResponse
			if unmarshalErr := json.Unmarshal(stdout.Bytes(), &providerResp); unmarshalErr == nil {
				if providerResp.Error != "" {
					return resp, fmt.Errorf("binary failed: %w (%s)", err, providerResp.Error)
				}
			}
		}

		stderrMsg := stderr.String()
		stdoutMsg := string(stdout.Bytes())
		if stderrMsg == "" && stdoutMsg != "" {
			return resp, fmt.Errorf("binary failed: %w (stdout: %s)", err, stdoutMsg)
		}
		return resp, fmt.Errorf("binary failed: %w (stderr: %s)", err, stderrMsg)
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
