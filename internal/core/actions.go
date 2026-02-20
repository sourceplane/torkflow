package core

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

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
			"core.sleep":    sleepAction,
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
	script, err := resolveScript(input)
	if err != nil {
		return nil, "", err
	}
	result, err := expression.EvalScript(script, context)
	if err != nil {
		return nil, "", err
	}
	if resMap, ok := result.(map[string]any); ok {
		return resMap, "", nil
	}
	return map[string]any{"result": result}, "", nil
}

func resolveScript(input map[string]any) (string, error) {
	inline, hasInline := input["script"].(string)
	inline = strings.TrimSpace(inline)

	filePath, _ := input["scriptFile"].(string)
	if filePath == "" {
		filePath, _ = input["scriptPath"].(string)
	}
	filePath = strings.TrimSpace(filePath)

	if inline != "" && filePath != "" {
		return "", errors.New("core.js accepts either script or scriptFile, not both")
	}

	if inline != "" {
		return inline, nil
	}

	if filePath != "" {
		content, err := os.ReadFile(filePath)
		if err != nil {
			return "", fmt.Errorf("core.js failed to read scriptFile %q: %w", filePath, err)
		}
		script := strings.TrimSpace(string(content))
		if script == "" {
			return "", fmt.Errorf("core.js scriptFile %q is empty", filePath)
		}
		return script, nil
	}

	if hasInline {
		return "", errors.New("core.js script cannot be empty")
	}

	return "", errors.New("core.js requires script or scriptFile")
}

func sleepAction(input map[string]any, context map[string]any) (map[string]any, string, error) {
	d, err := resolveSleepDuration(input)
	if err != nil {
		return nil, "", err
	}
	time.Sleep(d)
	return map[string]any{
		"duration": d.String(),
		"sleptMs":  d.Milliseconds(),
	}, "", nil
}

func resolveSleepDuration(input map[string]any) (time.Duration, error) {
	if raw, ok := input["duration"]; ok {
		switch v := raw.(type) {
		case string:
			d, err := time.ParseDuration(strings.TrimSpace(v))
			if err != nil {
				return 0, fmt.Errorf("core.sleep invalid duration %q: %w", v, err)
			}
			if d < 0 {
				return 0, errors.New("core.sleep duration cannot be negative")
			}
			return d, nil
		default:
			seconds, err := toFloat64(v)
			if err != nil {
				return 0, errors.New("core.sleep duration must be string or number")
			}
			if seconds < 0 {
				return 0, errors.New("core.sleep duration cannot be negative")
			}
			return time.Duration(seconds * float64(time.Second)), nil
		}
	}

	if raw, ok := input["seconds"]; ok {
		seconds, err := toFloat64(raw)
		if err != nil {
			return 0, errors.New("core.sleep seconds must be a number")
		}
		if seconds < 0 {
			return 0, errors.New("core.sleep seconds cannot be negative")
		}
		return time.Duration(seconds * float64(time.Second)), nil
	}

	if raw, ok := input["milliseconds"]; ok {
		ms, err := toFloat64(raw)
		if err != nil {
			return 0, errors.New("core.sleep milliseconds must be a number")
		}
		if ms < 0 {
			return 0, errors.New("core.sleep milliseconds cannot be negative")
		}
		return time.Duration(ms * float64(time.Millisecond)), nil
	}

	return 0, errors.New("core.sleep requires one of: duration, seconds, milliseconds")
}

func toFloat64(v any) (float64, error) {
	switch n := v.(type) {
	case int:
		return float64(n), nil
	case int8:
		return float64(n), nil
	case int16:
		return float64(n), nil
	case int32:
		return float64(n), nil
	case int64:
		return float64(n), nil
	case uint:
		return float64(n), nil
	case uint8:
		return float64(n), nil
	case uint16:
		return float64(n), nil
	case uint32:
		return float64(n), nil
	case uint64:
		return float64(n), nil
	case float32:
		return float64(n), nil
	case float64:
		return n, nil
	case string:
		return strconv.ParseFloat(strings.TrimSpace(n), 64)
	default:
		return 0, fmt.Errorf("unsupported numeric type %T", v)
	}
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
