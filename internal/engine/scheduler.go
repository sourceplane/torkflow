package engine

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"torkflow/internal/executor"
	"torkflow/internal/expression"
	"torkflow/internal/state"
	"torkflow/internal/workflow"
)

type Scheduler struct {
	engine *Engine
}

func NewScheduler(engine *Engine) *Scheduler {
	return &Scheduler{engine: engine}
}

func (s *Scheduler) Run() error {
	steps := s.engine.StepMap()
	inboundTotal := map[string]int{}
	inboundSatisfied := map[string]int{}
	for name, node := range s.engine.Graph.Nodes {
		inboundTotal[name] = node.InboundCount
		inboundSatisfied[name] = 0
	}

	st, err := s.engine.Store.LoadState()
	if err != nil {
		return err
	}

	status := map[string]string{}
	for stepName := range steps {
		status[stepName] = "PENDING"
	}
	for _, ready := range st.CurrentReadySteps {
		status[ready] = "READY"
	}

	readyCh := make(chan string, len(steps))
	for _, ready := range st.CurrentReadySteps {
		readyCh <- ready
	}

	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, s.engine.MaxParallel)

	totalSteps := len(steps)
	completed := 0
	failed := 0

	for completed+failed < totalSteps {
		select {
		case stepName := <-readyCh:
			mu.Lock()
			if status[stepName] != "READY" {
				mu.Unlock()
				continue
			}
			status[stepName] = "RUNNING"
			_ = s.updateState(status)
			mu.Unlock()

			sem <- struct{}{}
			wg.Add(1)
			go func(stepName string) {
				defer wg.Done()
				defer func() { <-sem }()

				step := steps[stepName]
				actionRef := step.EffectiveActionRef()
				ctxSnapshot, snapErr := s.engine.SnapshotContext()
				if snapErr != nil {
					s.markFailed(stepName, actionRef, snapErr, &state.StepRecord{Name: stepName, Status: "FAILED"})
					return
				}
				if step.SkipExpression != "" {
					skip, err := expression.Eval(step.SkipExpression, ctxSnapshot)
					if err == nil {
						if val, ok := skip.(bool); ok && val {
							mu.Lock()
							status[stepName] = "SKIPPED"
							completed++
							_ = s.updateState(status)
							mu.Unlock()
							return
						}
					}
				}

				record := state.StepRecord{Name: stepName, Status: "RUNNING"}
				started := time.Now().UTC()
				record.StartedAt = &started
				_ = s.engine.Store.SaveStep(record)

				input, err := resolveInput(step.Parameters, ctxSnapshot, s.engine.WorkflowDir)
				if err != nil {
					record.Input = map[string]any{"parameters": step.Parameters}
					s.markFailed(stepName, actionRef, err, &record)
					return
				}
				record.Input = input

				branch, output, execErr := s.executeStep(step, input, ctxSnapshot)
				if execErr != nil {
					s.handleFailure(step, stepName, execErr, &record, status, &completed, &failed, readyCh, &mu)
					return
				}

				record.Output = output
				if branch != "" {
					record.Branch = branch
				}
				ended := time.Now().UTC()
				record.EndedAt = &ended
				record.Status = "SUCCEEDED"
				_ = s.engine.Store.SaveStep(record)
				_ = s.engine.UpdateContext(stepName, output)
				if branch != "" {
					_ = s.engine.MarkBranch(stepName, branch)
				}

				mu.Lock()
				status[stepName] = "SUCCEEDED"
				completed++
				_ = s.updateState(status)
				mu.Unlock()

				s.scheduleOutbound(stepName, branch, inboundSatisfied, inboundTotal, status, readyCh, &mu)
			}(stepName)

		default:
			if completed+failed >= totalSteps {
				break
			}

			mu.Lock()
			readyCount := 0
			runningCount := 0
			pending := make([]string, 0)
			for name, st := range status {
				switch st {
				case "READY":
					readyCount++
				case "RUNNING":
					runningCount++
				case "PENDING":
					pending = append(pending, name)
				}
			}

			// No runnable work remains, but steps are still pending because their
			// dependencies can never be satisfied (for example: upstream failure).
			if readyCount == 0 && runningCount == 0 && len(pending) > 0 {
				for _, name := range pending {
					status[name] = "SKIPPED"
					completed++
				}
				_ = s.updateState(status)
				mu.Unlock()
				continue
			}
			mu.Unlock()

			time.Sleep(50 * time.Millisecond)
		}
	}

	wg.Wait()
	return nil
}

func (s *Scheduler) executeStep(step workflow.Step, input map[string]any, context map[string]any) (string, map[string]any, error) {
	actionRef := step.EffectiveActionRef()
	if handler, ok := s.engine.CoreRegistry.Get(actionRef); ok {
		output, branch, err := handler(input, context)
		return branch, output, err
	}

	action, ok := s.engine.Registry.Get(actionRef)
	if !ok {
		return "", nil, fmt.Errorf("unknown action %s", actionRef)
	}

	if action.InputSchema != nil {
		if err := s.engine.Validator.Validate(action.InputSchema, input); err != nil {
			return "", nil, fmt.Errorf("input schema validation failed for %s: %w", actionRef, err)
		}
	}

	credential, err := s.engine.ResolveCredential(step, action)
	if err != nil {
		return "", nil, err
	}
	request := executor.BinaryRequest{
		ActionRef:    actionRef,
		StepName:     step.Name,
		Input:        input,
		Credential:   credential,
		Connections:  credential,
		TimeoutSecs:  step.TimeoutSeconds,
		ExecutionID:  s.engine.ExecutionID,
		WorkflowID:   s.engine.WorkflowID,
		ProviderName: action.ModuleName,
		Metadata: map[string]any{
			"workflowId":  s.engine.WorkflowID,
			"executionId": s.engine.ExecutionID,
		},
	}

	effectiveTimeout := step.TimeoutSeconds
	if effectiveTimeout <= 0 {
		effectiveTimeout = int(action.Timeout.Seconds())
	}

	resp, err := executor.WithTimeout(effectiveTimeout, func() (executor.BinaryResponse, error) {
		return executor.RunBinary(action.Runtime.Entrypoint, request)
	})
	if err != nil {
		return "", nil, err
	}
	if resp.Status != "success" {
		return "", nil, errors.New(resp.Error)
	}

	if action.OutputSchema != nil {
		if err := s.engine.Validator.Validate(action.OutputSchema, resp.Output); err != nil {
			return "", nil, fmt.Errorf("output schema validation failed for %s: %w", actionRef, err)
		}
	}

	return resp.Branch, resp.Output, nil
}

func (s *Scheduler) scheduleOutbound(stepName, branch string, inboundSatisfied, inboundTotal map[string]int, status map[string]string, readyCh chan string, mu *sync.Mutex) {
	node := s.engine.Graph.Nodes[stepName]
	for _, edge := range node.Outbound {
		if edge.BranchName != "" && edge.BranchName != branch {
			continue
		}
		inboundSatisfied[edge.To]++

		threshold := s.engine.StepReadinessThreshold(edge.To)
		if threshold == "ANY" && inboundSatisfied[edge.To] >= 1 {
			mu.Lock()
			if status[edge.To] == "PENDING" {
				status[edge.To] = "READY"
				readyCh <- edge.To
			}
			mu.Unlock()
			continue
		}
		if inboundSatisfied[edge.To] >= inboundTotal[edge.To] {
			mu.Lock()
			if status[edge.To] == "PENDING" {
				status[edge.To] = "READY"
				readyCh <- edge.To
			}
			mu.Unlock()
		}
	}
}

func (s *Scheduler) handleFailure(step workflow.Step, stepName string, execErr error, record *state.StepRecord, status map[string]string, completed *int, failed *int, readyCh chan string, mu *sync.Mutex) {
	retryState, _ := s.engine.Store.LoadState()
	canRetry, delay := s.engine.DetermineRetry(step, retryState.RetryStates)
	if canRetry {
		retryState.RetryStates[stepName]++
		_ = s.engine.Store.SaveState(retryState)
		time.Sleep(delay)
		mu.Lock()
		status[stepName] = "READY"
		_ = s.updateState(status)
		mu.Unlock()
		readyCh <- stepName
		return
	}

	s.markFailed(stepName, step.EffectiveActionRef(), execErr, record)
	mu.Lock()
	status[stepName] = "FAILED"
	*failed += 1
	_ = s.updateState(status)
	mu.Unlock()

	if step.FallbackStep != "" {
		mu.Lock()
		if status[step.FallbackStep] == "PENDING" {
			status[step.FallbackStep] = "READY"
			_ = s.updateState(status)
			readyCh <- step.FallbackStep
		}
		mu.Unlock()
	}
	if step.ContinueOnError {
		return
	}
}

func (s *Scheduler) markFailed(stepName string, actionRef string, err error, record *state.StepRecord) {
	record.Status = "FAILED"
	record.Error = err.Error()
	ended := time.Now().UTC()
	record.EndedAt = &ended
	_ = s.engine.Store.SaveStep(*record)
	_ = s.engine.Store.AppendRunError(state.RunError{
		Timestamp: ended,
		StepName:  stepName,
		ActionRef: actionRef,
		Error:     err.Error(),
		Input:     record.Input,
	})
}

func (s *Scheduler) updateState(status map[string]string) error {
	st, err := s.engine.Store.LoadState()
	if err != nil {
		return err
	}
	st.CurrentReadySteps = []string{}
	st.CompletedSteps = []string{}
	st.FailedSteps = []string{}
	for name, value := range status {
		switch value {
		case "READY":
			st.CurrentReadySteps = append(st.CurrentReadySteps, name)
		case "SUCCEEDED", "SKIPPED":
			st.CompletedSteps = append(st.CompletedSteps, name)
		case "FAILED":
			st.FailedSteps = append(st.FailedSteps, name)
		}
	}
	return s.engine.Store.SaveState(st)
}

func resolveInput(input map[string]any, context map[string]any, workflowDir string) (map[string]any, error) {
	resolved := map[string]any{}
	for key, value := range input {
		res, err := resolveAny(value, context, workflowDir)
		if err != nil {
			return nil, err
		}
		resolved[key] = res
	}
	return resolved, nil
}

func resolveAny(value any, context map[string]any, workflowDir string) (any, error) {
	switch v := value.(type) {
	case string:
		return expression.ResolveString(v, context)
	case map[string]any:
		if len(v) == 1 {
			if source, ok := v["fromFile"]; ok {
				return resolveFromFile(source, context, workflowDir)
			}
		}
		return resolveInput(v, context, workflowDir)
	case []any:
		result := make([]any, 0, len(v))
		for _, item := range v {
			res, err := resolveAny(item, context, workflowDir)
			if err != nil {
				return nil, err
			}
			result = append(result, res)
		}
		return result, nil
	default:
		return v, nil
	}
}

func resolveFromFile(source any, context map[string]any, workflowDir string) (string, error) {
	path := ""
	template := false

	switch v := source.(type) {
	case string:
		path = v
	case map[string]any:
		for key := range v {
			if key != "path" && key != "template" {
				return "", fmt.Errorf("fromFile only supports path and template fields")
			}
		}
		if rawPath, ok := v["path"]; ok {
			if s, ok := rawPath.(string); ok {
				path = s
			} else {
				return "", fmt.Errorf("fromFile.path must be a string")
			}
		}
		if rawTemplate, ok := v["template"]; ok {
			if b, ok := rawTemplate.(bool); ok {
				template = b
			} else {
				return "", fmt.Errorf("fromFile.template must be a boolean")
			}
		}
	default:
		return "", fmt.Errorf("fromFile must be a string path or object")
	}

	path = filepath.Clean(path)
	if path == "." || path == "" {
		return "", fmt.Errorf("fromFile.path cannot be empty")
	}

	if !filepath.IsAbs(path) {
		path = filepath.Join(workflowDir, path)
	}

	content, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("fromFile read failed for %q: %w", path, err)
	}

	text := string(content)
	if !template {
		return text, nil
	}

	resolved, err := expression.ResolveString(text, context)
	if err != nil {
		return "", fmt.Errorf("fromFile template resolution failed for %q: %w", path, err)
	}
	return resolved, nil
}
