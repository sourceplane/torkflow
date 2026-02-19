package main

import "fmt"

func Dispatch(req RuntimeRequest) (RuntimeResponse, error) {
	var (
		result ProviderResult
		err    error
	)

	switch req.ActionRef {
	case "ai.openai.chat":
		result, err = handleOpenAIChat(req)
	case "ai.anthropic.chat":
		result, err = handleAnthropicChat(req)
	case "ai.bedrock.chat":
		result, err = handleBedrockChat(req)
	case "ai.gemini.chat":
		result, err = handleGeminiChat(req)
	default:
		return RuntimeResponse{}, fmt.Errorf("unsupported actionRef %q", req.ActionRef)
	}
	if err != nil {
		return RuntimeResponse{}, err
	}

	return RuntimeResponse{Status: "success", Output: toUnifiedOutput(req, result)}, nil
}
