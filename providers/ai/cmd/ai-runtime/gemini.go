package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

func handleGeminiChat(req RuntimeRequest) (ProviderResult, error) {
	model, _ := req.Input["model"].(string)
	if model == "" {
		return ProviderResult{}, fmt.Errorf("model is required")
	}
	apiKey, _ := req.Credential["apiKey"].(string)
	if strings.TrimSpace(apiKey) == "" {
		return ProviderResult{}, fmt.Errorf("gemini apiKey is required in credential")
	}
	baseURL, _ := req.Credential["baseURL"].(string)
	if strings.TrimSpace(baseURL) == "" {
		baseURL = "https://generativelanguage.googleapis.com"
	}
	baseURL = strings.TrimRight(baseURL, "/")

	messages, err := extractMessages(req.Input)
	if err != nil {
		return ProviderResult{}, err
	}

	contents := make([]map[string]any, 0, len(messages))
	for _, m := range messages {
		role := m["role"]
		if role == "assistant" {
			role = "model"
		}
		contents = append(contents, map[string]any{
			"role": role,
			"parts": []map[string]any{
				{"text": m["content"]},
			},
		})
	}

	body := map[string]any{"contents": contents}
	if cfg, ok := req.Input["generationConfig"].(map[string]any); ok {
		body["generationConfig"] = cfg
	}

	payload, err := json.Marshal(body)
	if err != nil {
		return ProviderResult{}, err
	}

	endpoint := fmt.Sprintf("%s/v1beta/models/%s:generateContent?key=%s", baseURL, url.PathEscape(model), url.QueryEscape(apiKey))
	httpReq, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return ProviderResult{}, err
	}
	httpReq.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 60 * time.Second}
	resp, err := client.Do(httpReq)
	if err != nil {
		return ProviderResult{}, err
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return ProviderResult{}, err
	}
	if resp.StatusCode >= 400 {
		return ProviderResult{}, fmt.Errorf("gemini API error status=%d body=%s", resp.StatusCode, string(respBody))
	}

	var decoded struct {
		Candidates []struct {
			Content struct {
				Parts []struct {
					Text string `json:"text"`
				} `json:"parts"`
			} `json:"content"`
		} `json:"candidates"`
		UsageMetadata struct {
			PromptTokenCount     int `json:"promptTokenCount"`
			CandidatesTokenCount int `json:"candidatesTokenCount"`
			TotalTokenCount      int `json:"totalTokenCount"`
		} `json:"usageMetadata"`
	}
	if err := json.Unmarshal(respBody, &decoded); err != nil {
		return ProviderResult{}, fmt.Errorf("gemini parse error: %w", err)
	}

	completion := ""
	if len(decoded.Candidates) > 0 {
		for _, part := range decoded.Candidates[0].Content.Parts {
			if strings.TrimSpace(part.Text) != "" {
				if completion != "" {
					completion += "\n"
				}
				completion += part.Text
			}
		}
	}
	if strings.TrimSpace(completion) == "" {
		completion = "(empty response)"
	}

	usage := Usage{
		PromptTokens:     decoded.UsageMetadata.PromptTokenCount,
		CompletionTokens: decoded.UsageMetadata.CandidatesTokenCount,
		TotalTokens:      decoded.UsageMetadata.TotalTokenCount,
	}
	if usage.TotalTokens == 0 {
		usage = estimateUsage(promptText(messages), completion)
	}

	return ProviderResult{
		Text:  completion,
		Usage: usage,
		Provider: map[string]any{
			"provider": "gemini",
			"model":    model,
			"status":   resp.StatusCode,
		},
	}, nil
}
