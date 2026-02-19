package main

import "fmt"

func handleBedrockChat(req RuntimeRequest) (ProviderResult, error) {
	modelID, _ := req.Input["modelId"].(string)
	if modelID == "" {
		return ProviderResult{}, fmt.Errorf("modelId is required")
	}
	region, _ := req.Input["region"].(string)
	if region == "" {
		if v, ok := req.Credential["region"].(string); ok {
			region = v
		}
	}
	if region == "" {
		region = "us-east-1"
	}

	messages, err := extractMessages(req.Input)
	if err != nil {
		return ProviderResult{}, err
	}

	completion := synthesizeResponse("bedrock", modelID, messages)
	usage := estimateUsage(promptText(messages), completion)

	return ProviderResult{
		Text:  completion,
		Usage: usage,
		Provider: map[string]any{
			"provider": "bedrock",
			"modelId":  modelID,
			"region":   region,
			"mock":     true,
		},
	}, nil
}
