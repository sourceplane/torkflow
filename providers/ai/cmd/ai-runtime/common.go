package main

import (
	"fmt"
	"strings"
)

func extractMessages(input map[string]any) ([]map[string]string, error) {
	raw, ok := input["messages"].([]any)
	if !ok || len(raw) == 0 {
		return nil, fmt.Errorf("messages must be a non-empty array")
	}
	messages := make([]map[string]string, 0, len(raw))
	for i, item := range raw {
		msg, ok := item.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("messages[%d] must be an object", i)
		}
		role, _ := msg["role"].(string)
		content, _ := msg["content"].(string)
		if role == "" || content == "" {
			return nil, fmt.Errorf("messages[%d] requires role and content", i)
		}
		messages = append(messages, map[string]string{"role": role, "content": content})
	}
	return messages, nil
}

func estimateUsage(prompt string, completion string) Usage {
	promptTokens := max(1, len([]rune(prompt))/4)
	completionTokens := max(1, len([]rune(completion))/4)
	return Usage{
		PromptTokens:     promptTokens,
		CompletionTokens: completionTokens,
		TotalTokens:      promptTokens + completionTokens,
	}
}

func synthesizeResponse(provider string, model string, messages []map[string]string) string {
	last := messages[len(messages)-1]["content"]
	last = strings.TrimSpace(last)
	if len(last) > 220 {
		last = last[:220] + "..."
	}
	return fmt.Sprintf("[%s:%s] %s", provider, model, last)
}

func promptText(messages []map[string]string) string {
	parts := make([]string, 0, len(messages))
	for _, m := range messages {
		parts = append(parts, m["role"]+": "+m["content"])
	}
	return strings.Join(parts, "\n")
}

func toUnifiedOutput(req RuntimeRequest, result ProviderResult) map[string]any {
	return map[string]any{
		"text":      result.Text,
		"toolCalls": []any{},
		"usage": map[string]any{
			"promptTokens":     result.Usage.PromptTokens,
			"completionTokens": result.Usage.CompletionTokens,
			"totalTokens":      result.Usage.TotalTokens,
		},
		"providerMetadata": map[string]any{
			"actionRef":   req.ActionRef,
			"rawResponse": result.Provider,
		},
	}
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
