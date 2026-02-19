package validation

import (
	"encoding/json"
	"fmt"
	"sync"

	"github.com/xeipuuv/gojsonschema"
)

type JSONSchemaValidator struct {
	mu       sync.RWMutex
	compiled map[string]*gojsonschema.Schema
}

func NewJSONSchemaValidator() *JSONSchemaValidator {
	return &JSONSchemaValidator{compiled: map[string]*gojsonschema.Schema{}}
}

func (v *JSONSchemaValidator) Validate(schemaRef any, payload any) error {
	if schemaRef == nil {
		return nil
	}
	if path, ok := schemaRef.(string); ok && path == "" {
		return nil
	}

	schema, err := v.get(schemaRef)
	if err != nil {
		return err
	}

	result, err := schema.Validate(gojsonschema.NewGoLoader(payload))
	if err != nil {
		return err
	}
	if result.Valid() {
		return nil
	}
	if len(result.Errors()) == 0 {
		return fmt.Errorf("schema validation failed")
	}
	return fmt.Errorf(result.Errors()[0].String())
}

func (v *JSONSchemaValidator) get(schemaRef any) (*gojsonschema.Schema, error) {
	cacheKey, loader, err := schemaLoader(schemaRef)
	if err != nil {
		return nil, err
	}

	v.mu.RLock()
	if schema, ok := v.compiled[cacheKey]; ok {
		v.mu.RUnlock()
		return schema, nil
	}
	v.mu.RUnlock()

	schema, err := gojsonschema.NewSchema(loader)
	if err != nil {
		return nil, err
	}

	v.mu.Lock()
	v.compiled[cacheKey] = schema
	v.mu.Unlock()
	return schema, nil
}

func schemaLoader(schemaRef any) (string, gojsonschema.JSONLoader, error) {
	if path, ok := schemaRef.(string); ok {
		return "file:" + path, gojsonschema.NewReferenceLoader("file://" + path), nil
	}
	payload, err := json.Marshal(schemaRef)
	if err != nil {
		return "", nil, err
	}
	key := "inline:" + string(payload)
	return key, gojsonschema.NewBytesLoader(payload), nil
}
