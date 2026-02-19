package main

import "fmt"

func handleOpenAIChat(req RuntimeRequest) (ProviderResult, error) {
	model, _ := req.Input["model"].(string)
	if model == "" {
		return ProviderResult{}, fmt.Errorf("model is required")
	}
	messages, err := extractMessages(req.Input)
	if err != nil {
		return ProviderResult{}, err
	}

	completion := synthesizeResponse("openai", model, messages)
	usage := estimateUsage(promptText(messages), completion)

	return ProviderResult{
		Text:  completion,
		Usage: usage,
		Provider: map[string]any{
			"provider": "openai",
			"model":    model,
			"mock":     true,
		},
	}, nil
}
