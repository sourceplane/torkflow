package main

import (
	"encoding/json"
	"fmt"
	"os"
)

func main() {
	defer func() {
		if r := recover(); r != nil {
			err := fmt.Errorf("panic: %v", r)
			writeError(RuntimeRequest{}, err)
			os.Exit(1)
		}
	}()

	var req RuntimeRequest
	if err := json.NewDecoder(os.Stdin).Decode(&req); err != nil {
		writeError(req, fmt.Errorf("invalid stdin payload: %w", err))
		os.Exit(1)
	}

	resp, err := Dispatch(req)
	if err != nil {
		writeError(req, err)
		os.Exit(1)
	}

	if err := json.NewEncoder(os.Stdout).Encode(resp); err != nil {
		writeError(req, fmt.Errorf("failed writing response: %w", err))
		os.Exit(1)
	}
}

func writeError(req RuntimeRequest, err error) {
	_, _ = fmt.Fprintf(os.Stderr, "[ai-runtime] actionRef=%s step=%s error=%s\n", req.ActionRef, req.StepName, err.Error())
	_ = json.NewEncoder(os.Stdout).Encode(RuntimeResponse{Status: "error", Error: err.Error()})
}
