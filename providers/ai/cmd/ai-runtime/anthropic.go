package main

import "fmt"

func handleAnthropicChat(req RuntimeRequest) (ProviderResult, error) {
	model, _ := req.Input["model"].(string)
	if model == "" {
		return ProviderResult{}, fmt.Errorf("model is required")
	}
	messages, err := extractMessages(req.Input)
	if err != nil {
		return ProviderResult{}, err
	}

	completion := synthesizeResponse("anthropic", model, messages)
	usage := estimateUsage(promptText(messages), completion)

	return ProviderResult{
		Text:  completion,
		Usage: usage,
		Provider: map[string]any{
			"provider": "anthropic",
			"model":    model,
			"mock":     true,
		},
	}, nil
}
