package cli

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"torkflow/internal/workflow"
)

type dagRenderOptions struct {
	RunDir       string
	Live         bool
	SpinnerFrame int
}

type runtimeStepStatus struct {
	Status string
	Error  string
}

func renderDAG(wf workflow.Workflow, opts dagRenderOptions) string {
	stepsByName := make(map[string]workflow.Step, len(wf.Spec.Steps))
	indegree := make(map[string]int, len(wf.Spec.Steps))
	outdegree := make(map[string]int, len(wf.Spec.Steps))
	adj := make(map[string][]workflow.OutboundEdge, len(wf.Spec.Steps))
	edgeCount := 0

	for _, s := range wf.Spec.Steps {
		stepsByName[s.Name] = s
		if _, ok := indegree[s.Name]; !ok {
			indegree[s.Name] = 0
		}
		if _, ok := outdegree[s.Name]; !ok {
			outdegree[s.Name] = 0
		}
	}

	for _, s := range wf.Spec.Steps {
		adj[s.Name] = append(adj[s.Name], s.OutboundEdges...)
		edgeCount += len(s.OutboundEdges)
		outdegree[s.Name] = len(s.OutboundEdges)
		sort.Slice(adj[s.Name], func(i, j int) bool {
			left := adj[s.Name][i].NextStepName + "|" + adj[s.Name][i].BranchName
			right := adj[s.Name][j].NextStepName + "|" + adj[s.Name][j].BranchName
			return left < right
		})
		for _, e := range s.OutboundEdges {
			indegree[e.NextStepName]++
		}
	}

	roots := make([]string, 0)
	leaves := make([]string, 0)
	for name, d := range indegree {
		if d == 0 {
			roots = append(roots, name)
		}
		if outdegree[name] == 0 {
			leaves = append(leaves, name)
		}
	}
	sort.Strings(roots)
	sort.Strings(leaves)

	queue := append([]string{}, roots...)
	level := map[string]int{}
	for _, r := range roots {
		level[r] = 0
	}

	remaining := map[string]int{}
	for k, v := range indegree {
		remaining[k] = v
	}

	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		for _, e := range adj[cur] {
			if level[e.NextStepName] < level[cur]+1 {
				level[e.NextStepName] = level[cur] + 1
			}
			remaining[e.NextStepName]--
			if remaining[e.NextStepName] == 0 {
				queue = append(queue, e.NextStepName)
				sort.Strings(queue)
			}
		}
	}

	for name := range stepsByName {
		if _, ok := level[name]; !ok {
			level[name] = 0
		}
	}

	layers := map[int][]string{}
	maxLayer := 0
	for name, l := range level {
		layers[l] = append(layers[l], name)
		if l > maxLayer {
			maxLayer = l
		}
	}
	for l := 0; l <= maxLayer; l++ {
		sort.Strings(layers[l])
	}

	workflowName := wf.Metadata.ID
	if workflowName == "" {
		workflowName = wf.Metadata.Name
	}
	if workflowName == "" {
		workflowName = "workflow"
	}
	runtimeStatuses := loadRuntimeStepStatuses(opts.RunDir)

	b := strings.Builder{}
	b.WriteString("╭─ Workflow DAG (advanced): ")
	b.WriteString(workflowName)
	b.WriteString("\n")
	b.WriteString(fmt.Sprintf("│ Nodes: %d  Edges: %d  MaxParallel: %d\n", len(stepsByName), edgeCount, wf.Spec.MaxParallelSteps))
	b.WriteString("│ Roots: ")
	if len(roots) == 0 {
		b.WriteString("(none)")
	} else {
		b.WriteString(strings.Join(roots, ", "))
	}
	b.WriteString("\n")
	b.WriteString("│ Leaves: ")
	if len(leaves) == 0 {
		b.WriteString("(none)")
	} else {
		b.WriteString(strings.Join(leaves, ", "))
	}
	b.WriteString("\n")

	if opts.RunDir != "" {
		b.WriteString("│ RunDir: ")
		b.WriteString(opts.RunDir)
		b.WriteString("\n")
	}

	if len(runtimeStatuses) > 0 {
		summary := summarizeRuntimeStatuses(runtimeStatuses, stepsByName)
		b.WriteString("│ Runtime: ")
		b.WriteString(summary)
		b.WriteString("\n")
	}

	for l := 0; l <= maxLayer; l++ {
		if len(layers[l]) == 0 {
			continue
		}
		b.WriteString("│\n")
		b.WriteString(fmt.Sprintf("│ Stage %d\n", l))
		for _, name := range layers[l] {
			s := stepsByName[name]
			action := s.EffectiveActionRef()
			if action == "" {
				action = "(none)"
			}
			status := runtimeStatuses[name]
			badge := statusBadge(status.Status, opts.Live, opts.SpinnerFrame)

			b.WriteString("│   • ")
			b.WriteString(badge)
			b.WriteString(" ")
			b.WriteString(name)
			b.WriteString("  [")
			b.WriteString(action)
			b.WriteString("]\n")

			gate := "ALL"
			if s.ReadinessGate != nil && s.ReadinessGate.ThresholdType != "" {
				gate = s.ReadinessGate.ThresholdType
			}
			meta := fmt.Sprintf("in=%d out=%d gate=%s", indegree[name], outdegree[name], gate)
			if s.Connection != "" {
				meta += " conn=" + s.Connection
			}
			if s.ContinueOnError {
				meta += " continueOnError=true"
			}
			if s.FallbackStep != "" {
				meta += " fallback=" + s.FallbackStep
			}
			b.WriteString("│     · ")
			b.WriteString(meta)
			b.WriteString("\n")

			if status.Error != "" {
				b.WriteString("│     ! error: ")
				b.WriteString(shorten(status.Error, 140))
				b.WriteString("\n")
			}

			edges := adj[name]
			if len(edges) == 0 {
				b.WriteString("│     └─ no outbound\n")
				continue
			}
			for i, e := range edges {
				connector := "├"
				if i == len(edges)-1 {
					connector = "└"
				}
				branch := ""
				if e.BranchName != "" {
					branch = "  [branch=" + e.BranchName + "]"
				}
				b.WriteString("│     ")
				b.WriteString(connector)
				b.WriteString("─→ ")
				b.WriteString(e.NextStepName)
				b.WriteString(branch)
				b.WriteString("\n")
			}
		}
	}

	b.WriteString("│\n")
	b.WriteString("│ Legend: ✓ succeeded  ✗ failed  ↷ skipped  ○ unknown")
	if opts.Live {
		b.WriteString("  ⠋/⠙/⠹ running")
	} else {
		b.WriteString("  … running/pending")
	}
	b.WriteString("\n")
	b.WriteString("╰────────────────────────────────────────\n")
	return b.String()
}

func workflowIdentifier(wf workflow.Workflow) string {
	workflowName := wf.Metadata.ID
	if workflowName == "" {
		workflowName = wf.Metadata.Name
	}
	if workflowName == "" {
		workflowName = "workflow"
	}
	return workflowName
}

func statusBadge(status string, live bool, frame int) string {
	switch strings.ToUpper(status) {
	case "SUCCEEDED":
		return "✓"
	case "FAILED":
		return "✗"
	case "RUNNING", "READY", "PENDING":
		if live {
			return spinner(frame)
		}
		return "…"
	case "SKIPPED":
		return "↷"
	default:
		return "○"
	}
}

func spinner(frame int) string {
	frames := []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}
	if len(frames) == 0 {
		return "…"
	}
	if frame < 0 {
		frame = 0
	}
	return frames[frame%len(frames)]
}

func shorten(input string, max int) string {
	if len(input) <= max {
		return input
	}
	if max < 4 {
		return input[:max]
	}
	return input[:max-3] + "..."
}

func loadRuntimeStepStatuses(runDir string) map[string]runtimeStepStatus {
	statuses := map[string]runtimeStepStatus{}
	if runDir == "" {
		return statuses
	}

	stepsDir := filepath.Join(runDir, "steps")
	entries, err := os.ReadDir(stepsDir)
	if err != nil {
		return statuses
	}

	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(stepsDir, entry.Name()))
		if err != nil {
			continue
		}
		var payload struct {
			Name   string `json:"name"`
			Status string `json:"status"`
			Error  string `json:"error"`
		}
		if err := json.Unmarshal(data, &payload); err != nil {
			continue
		}
		if payload.Name == "" {
			continue
		}
		statuses[payload.Name] = runtimeStepStatus{
			Status: payload.Status,
			Error:  payload.Error,
		}
	}

	return statuses
}

func summarizeRuntimeStatuses(statuses map[string]runtimeStepStatus, stepsByName map[string]workflow.Step) string {
	counts := map[string]int{}
	for stepName, st := range statuses {
		if _, ok := stepsByName[stepName]; !ok {
			continue
		}
		key := strings.ToUpper(st.Status)
		if key == "" {
			key = "UNKNOWN"
		}
		counts[key]++
	}

	ordered := []string{"SUCCEEDED", "FAILED", "RUNNING", "READY", "PENDING", "SKIPPED", "UNKNOWN"}
	parts := make([]string, 0, len(ordered))
	for _, key := range ordered {
		if counts[key] == 0 {
			continue
		}
		parts = append(parts, fmt.Sprintf("%s=%d", strings.ToLower(key), counts[key]))
	}
	if len(parts) == 0 {
		return "no status data"
	}
	return strings.Join(parts, "  ")
}
