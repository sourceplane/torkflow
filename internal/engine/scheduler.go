package engine

import (
	"errors"
	"fmt"
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
				if step.SkipExpression != "" {
					skip, err := expression.Eval(step.SkipExpression, s.engine.Context)
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

				input, err := resolveInput(step.Parameters, s.engine.Context)
				if err != nil {
					s.markFailed(stepName, err, &record)
					return
				}

				branch, output, execErr := s.executeStep(step, input)
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

func (s *Scheduler) executeStep(step workflow.Step, input map[string]any) (string, map[string]any, error) {
	if handler, ok := s.engine.CoreRegistry.Get(step.ActionID); ok {
		output, branch, err := handler(input, s.engine.Context)
		return branch, output, err
	}

	action, ok := s.engine.Registry.Get(step.ActionID)
	if !ok {
		return "", nil, fmt.Errorf("unknown action %s", step.ActionID)
	}

	connections := s.engine.ResolveConnections(step)
	request := executor.BinaryRequest{
		StepName:     step.Name,
		Input:        input,
		Connections:  connections,
		TimeoutSecs:  step.TimeoutSeconds,
		ExecutionID:  s.engine.ExecutionID,
		WorkflowID:   s.engine.WorkflowID,
		ProviderName: action.Provider,
	}

	resp, err := executor.WithTimeout(step.TimeoutSeconds, func() (executor.BinaryResponse, error) {
		return executor.RunBinary(action.Entrypoint, request)
	})
	if err != nil {
		return "", nil, err
	}
	if resp.Status != "success" {
		return "", nil, errors.New(resp.Error)
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

	s.markFailed(stepName, execErr, record)
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

func (s *Scheduler) markFailed(stepName string, err error, record *state.StepRecord) {
	record.Status = "FAILED"
	record.Error = err.Error()
	ended := time.Now().UTC()
	record.EndedAt = &ended
	_ = s.engine.Store.SaveStep(*record)
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

func resolveInput(input map[string]any, context map[string]any) (map[string]any, error) {
	resolved := map[string]any{}
	for key, value := range input {
		res, err := resolveAny(value, context)
		if err != nil {
			return nil, err
		}
		resolved[key] = res
	}
	return resolved, nil
}

func resolveAny(value any, context map[string]any) (any, error) {
	switch v := value.(type) {
	case string:
		return expression.ResolveString(v, context)
	case map[string]any:
		return resolveInput(v, context)
	case []any:
		result := make([]any, 0, len(v))
		for _, item := range v {
			res, err := resolveAny(item, context)
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
