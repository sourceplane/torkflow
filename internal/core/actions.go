package core

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"

	"torkflow/internal/expression"
)

type Handler func(input map[string]any, context map[string]any) (map[string]any, string, error)

type Registry struct {
	actions map[string]Handler
}

func NewRegistry() *Registry {
	return &Registry{
		actions: map[string]Handler{
			"core.if":       ifAction,
			"core.js":       jsAction,
			"core.print":    printAction,
			"core.stdPrint": printAction,
			"core.stdout":   printAction,
		},
	}
}

func (r *Registry) Get(id string) (Handler, bool) {
	h, ok := r.actions[id]
	return h, ok
}

func ifAction(input map[string]any, context map[string]any) (map[string]any, string, error) {
	condAny, ok := input["condition"].(string)
	if !ok {
		return nil, "", errors.New("core.if requires string condition")
	}
	result, err := expression.Eval(condAny, context)
	if err != nil {
		return nil, "", err
	}
	branch := "false"
	if v, ok := result.(bool); ok && v {
		branch = "true"
	}
	return map[string]any{"result": result}, branch, nil
}

func jsAction(input map[string]any, context map[string]any) (map[string]any, string, error) {
	script, ok := input["script"].(string)
	if !ok {
		return nil, "", errors.New("core.js requires script")
	}
	result, err := expression.Eval(script, context)
	if err != nil {
		return nil, "", err
	}
	if resMap, ok := result.(map[string]any); ok {
		return resMap, "", nil
	}
	return map[string]any{"result": result}, "", nil
}

func printAction(input map[string]any, context map[string]any) (map[string]any, string, error) {
	label := "Workflow Output"
	if rawLabel, ok := input["label"]; ok {
		if str, ok := rawLabel.(string); ok && str != "" {
			label = str
		}
	}
	if rawTitle, ok := input["title"]; ok {
		if str, ok := rawTitle.(string); ok && str != "" {
			label = str
		}
	}

	format := "pretty"
	if rawFormat, ok := input["format"]; ok {
		if str, ok := rawFormat.(string); ok && str != "" {
			format = strings.ToLower(str)
		}
	}

	payload := input
	if rawPayload, ok := input["payload"]; ok {
		switch v := rawPayload.(type) {
		case map[string]any:
			payload = v
		default:
			payload = map[string]any{"value": v}
		}
	}

	formatted, err := formatOutput(format, label, payload)
	if err != nil {
		return nil, "", err
	}

	fmt.Println(formatted)
	return map[string]any{
		"label":    label,
		"format":   format,
		"printed":  payload,
		"rendered": formatted,
	}, "", nil
}

func formatOutput(format, label string, payload any) (string, error) {
	switch format {
	case "json":
		formatted, err := json.MarshalIndent(payload, "", "  ")
		if err != nil {
			return "", err
		}
		return fmt.Sprintf("[%s]\n%s", label, string(formatted)), nil
	case "text", "kv":
		lines := []string{fmt.Sprintf("%s", label)}
		lines = append(lines, flattenKV("", payload)...)
		return strings.Join(lines, "\n"), nil
	case "pretty", "":
		body := flattenKV("", payload)
		if len(body) == 0 {
			body = []string{"• (empty)"}
		}
		top := "╭─ " + label
		middle := make([]string, 0, len(body))
		for _, line := range body {
			middle = append(middle, "│ "+line)
		}
		bottom := "╰────────────────────────────────────────"
		return strings.Join(append(append([]string{top}, middle...), bottom), "\n"), nil
	default:
		return "", fmt.Errorf("unsupported print format %q", format)
	}
}

func flattenKV(prefix string, value any) []string {
	switch v := value.(type) {
	case map[string]any:
		keys := make([]string, 0, len(v))
		for k := range v {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		lines := make([]string, 0)
		for _, k := range keys {
			nextPrefix := k
			if prefix != "" {
				nextPrefix = prefix + "." + k
			}
			lines = append(lines, flattenKV(nextPrefix, v[k])...)
		}
		return lines
	case []any:
		lines := make([]string, 0, len(v))
		for i, item := range v {
			nextPrefix := fmt.Sprintf("%s[%d]", prefix, i)
			if prefix == "" {
				nextPrefix = fmt.Sprintf("[%d]", i)
			}
			lines = append(lines, flattenKV(nextPrefix, item)...)
		}
		return lines
	default:
		key := prefix
		if key == "" {
			key = "value"
		}
		return []string{fmt.Sprintf("• %s: %v", key, v)}
	}
}
