package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

type RequestEnvelope struct {
	StepName    string         `json:"stepName"`
	Input       map[string]any `json:"input"`
	Connections map[string]any `json:"connections"`
}

type ResponseEnvelope struct {
	Status string         `json:"status"`
	Output map[string]any `json:"output,omitempty"`
	Error  string         `json:"error,omitempty"`
}

func main() {
	var reqEnv RequestEnvelope
	if err := json.NewDecoder(os.Stdin).Decode(&reqEnv); err != nil {
		fail("invalid stdin payload: %v", err)
	}

	url, ok := getString(reqEnv.Input, "url")
	if !ok || strings.TrimSpace(url) == "" {
		fail("http.request requires input.url")
	}

	method, ok := getString(reqEnv.Input, "method")
	if !ok || method == "" {
		method = http.MethodGet
	}

	var bodyReader io.Reader
	if bodyRaw, exists := reqEnv.Input["body"]; exists {
		switch v := bodyRaw.(type) {
		case string:
			bodyReader = strings.NewReader(v)
		default:
			payload, err := json.Marshal(v)
			if err != nil {
				fail("failed to marshal request body: %v", err)
			}
			bodyReader = bytes.NewReader(payload)
		}
	}

	httpReq, err := http.NewRequest(strings.ToUpper(method), url, bodyReader)
	if err != nil {
		fail("failed to build request: %v", err)
	}

	if headersAny, ok := reqEnv.Input["headers"]; ok {
		if headersMap, ok := headersAny.(map[string]any); ok {
			for k, v := range headersMap {
				httpReq.Header.Set(k, fmt.Sprintf("%v", v))
			}
		}
	}

	timeoutSeconds := getInt(reqEnv.Input, "timeoutSeconds", 15)
	client := &http.Client{Timeout: time.Duration(timeoutSeconds) * time.Second}

	resp, err := client.Do(httpReq)
	if err != nil {
		fail("request failed: %v", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		fail("failed reading response body: %v", err)
	}

	headers := map[string]any{}
	for k, vals := range resp.Header {
		headers[k] = strings.Join(vals, ",")
	}

	output := map[string]any{
		"statusCode": resp.StatusCode,
		"headers":    headers,
		"body":       string(respBody),
	}

	if shouldParseJSON(reqEnv.Input) {
		var parsed any
		if err := json.Unmarshal(respBody, &parsed); err == nil {
			output["json"] = parsed
		}
	}

	if resp.StatusCode >= 400 {
		write(ResponseEnvelope{Status: "error", Error: fmt.Sprintf("http status %d", resp.StatusCode), Output: output})
		os.Exit(1)
	}

	write(ResponseEnvelope{Status: "success", Output: output})
}

func shouldParseJSON(input map[string]any) bool {
	if v, ok := input["parseJson"]; ok {
		if b, ok := v.(bool); ok {
			return b
		}
	}
	return true
}

func getString(input map[string]any, key string) (string, bool) {
	v, ok := input[key]
	if !ok {
		return "", false
	}
	str, ok := v.(string)
	return str, ok
}

func getInt(input map[string]any, key string, def int) int {
	v, ok := input[key]
	if !ok {
		return def
	}
	switch n := v.(type) {
	case int:
		return n
	case int64:
		return int(n)
	case float64:
		return int(n)
	default:
		return def
	}
}

func fail(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
	os.Exit(1)
}

func write(resp ResponseEnvelope) {
	_ = json.NewEncoder(os.Stdout).Encode(resp)
}
