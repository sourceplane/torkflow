package registry

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"gopkg.in/yaml.v3"
)

type RuntimeRef struct {
	Type       string `yaml:"type"`
	Entrypoint string `yaml:"entrypoint"`
}

type ActionModuleSpec struct {
	APIVersion string `yaml:"apiVersion"`
	Kind       string `yaml:"kind"`
	Metadata   struct {
		Name        string `yaml:"name"`
		Version     string `yaml:"version"`
		Description string `yaml:"description"`
	} `yaml:"metadata"`
	Runtime         RuntimeRef                    `yaml:"runtime"`
	ActionsFile     string                        `yaml:"actionsFile"`
	Actions         []ActionSpec                  `yaml:"actions"`
	ConnectionTypes map[string]ConnectionTypeSpec `yaml:"connectionTypes"`
}

type ConnectionTypeSpec struct {
	Description string `yaml:"description"`
	Schema      any    `yaml:"schema"`
}

type ActionsSpec struct {
	APIVersion string       `yaml:"apiVersion"`
	Kind       string       `yaml:"kind"`
	Actions    []ActionSpec `yaml:"actions"`
}

type ActionSpec struct {
	Name           string   `yaml:"name"`
	Version        string   `yaml:"version"`
	Description    string   `yaml:"description"`
	InputSchema    any      `yaml:"inputSchema"`
	OutputSchema   any      `yaml:"outputSchema"`
	CredentialType string   `yaml:"credentialType"`
	Timeout        string   `yaml:"timeout"`
	Capabilities   []string `yaml:"capabilities"`
}

type ActionDescriptor struct {
	Name             string
	ModuleName       string
	ModuleVersion    string
	Description      string
	InputSchema      any
	OutputSchema     any
	CredentialType   string
	CredentialSchema any
	Timeout          time.Duration
	Capabilities     []string
	Runtime          RuntimeRef
}

type Registry struct {
	Actions map[string]ActionDescriptor
}

func NewRegistry() *Registry {
	return &Registry{Actions: map[string]ActionDescriptor{}}
}

func (r *Registry) Register(action ActionDescriptor) {
	r.Actions[action.Name] = action
}

func (r *Registry) Get(actionRef string) (ActionDescriptor, bool) {
	action, ok := r.Actions[actionRef]
	return action, ok
}

func (r *Registry) LoadFromDir(dir string) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		moduleDir := filepath.Join(dir, entry.Name())

		loaded, err := r.loadActionModule(moduleDir)
		if err != nil {
			return err
		}
		if loaded {
			continue
		}

		if err := r.loadLegacyProvider(moduleDir); err != nil {
			return err
		}
	}
	return nil
}

func (r *Registry) loadActionModule(moduleDir string) (bool, error) {
	modulePath := filepath.Join(moduleDir, "actionModule.yaml")
	moduleData, err := os.ReadFile(modulePath)
	if err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, err
	}

	var module ActionModuleSpec
	if err := yaml.Unmarshal(moduleData, &module); err != nil {
		return false, fmt.Errorf("action module %s: %w", moduleDir, err)
	}

	actions := module.Actions
	if len(actions) == 0 {
		actionsPath := module.ActionsFile
		if actionsPath == "" {
			return false, errors.New("action module has no actions (expected actions block)")
		}
		if !filepath.IsAbs(actionsPath) {
			actionsPath = filepath.Join(moduleDir, actionsPath)
		}

		actionsData, err := os.ReadFile(actionsPath)
		if err != nil {
			return false, fmt.Errorf("actions file %s: %w", actionsPath, err)
		}

		var actionsSpec ActionsSpec
		if err := yaml.Unmarshal(actionsData, &actionsSpec); err != nil {
			return false, fmt.Errorf("actions file %s: %w", actionsPath, err)
		}
		actions = actionsSpec.Actions
	}

	runtimeEntrypoint := module.Runtime.Entrypoint
	if runtimeEntrypoint == "" {
		return false, fmt.Errorf("action module %s missing runtime.entrypoint", moduleDir)
	}
	if !filepath.IsAbs(runtimeEntrypoint) {
		runtimeEntrypoint = filepath.Join(moduleDir, runtimeEntrypoint)
	}

	for _, action := range actions {
		if action.Name == "" {
			return false, fmt.Errorf("action module %s contains action without name", moduleDir)
		}
		timeout := 30 * time.Second
		if action.Timeout != "" {
			parsed, err := time.ParseDuration(action.Timeout)
			if err != nil {
				return false, fmt.Errorf("action %s invalid timeout %q: %w", action.Name, action.Timeout, err)
			}
			timeout = parsed
		}

		inputSchema, err := normalizeSchemaRef(action.InputSchema, moduleDir)
		if err != nil {
			return false, fmt.Errorf("action %s input schema: %w", action.Name, err)
		}
		outputSchema, err := normalizeSchemaRef(action.OutputSchema, moduleDir)
		if err != nil {
			return false, fmt.Errorf("action %s output schema: %w", action.Name, err)
		}

		credentialSchema := any(nil)
		if action.CredentialType != "" {
			if ct, ok := module.ConnectionTypes[action.CredentialType]; ok {
				credentialSchema = ct.Schema
			}
		}

		r.Register(ActionDescriptor{
			Name:             action.Name,
			ModuleName:       module.Metadata.Name,
			ModuleVersion:    module.Metadata.Version,
			Description:      action.Description,
			InputSchema:      inputSchema,
			OutputSchema:     outputSchema,
			CredentialType:   action.CredentialType,
			CredentialSchema: credentialSchema,
			Timeout:          timeout,
			Capabilities:     action.Capabilities,
			Runtime: RuntimeRef{
				Type:       module.Runtime.Type,
				Entrypoint: runtimeEntrypoint,
			},
		})
	}

	return true, nil
}

func normalizeSchemaRef(value any, moduleDir string) (any, error) {
	if value == nil {
		return nil, nil
	}
	if path, ok := value.(string); ok {
		if path == "" {
			return nil, nil
		}
		if filepath.IsAbs(path) {
			return path, nil
		}
		candidate := filepath.Join(moduleDir, path)
		if _, err := os.Stat(candidate); err == nil {
			return candidate, nil
		}
		// If string is not an existing path, it is likely not a valid schema reference.
		return nil, fmt.Errorf("schema path not found: %s", candidate)
	}
	return value, nil
}

type legacyProviderSpec struct {
	Provider string `yaml:"provider"`
	Version  string `yaml:"version"`
	Runtime  string `yaml:"runtime"`
	Actions  []struct {
		ID           string `yaml:"id"`
		Entrypoint   string `yaml:"entrypoint"`
		InputSchema  any    `yaml:"inputSchema"`
		OutputSchema any    `yaml:"outputSchema"`
	} `yaml:"actions"`
}

func (r *Registry) loadLegacyProvider(moduleDir string) error {
	legacyPath := filepath.Join(moduleDir, "provider.yaml")
	data, err := os.ReadFile(legacyPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}

	var spec legacyProviderSpec
	if err := yaml.Unmarshal(data, &spec); err != nil {
		return fmt.Errorf("legacy provider %s: %w", moduleDir, err)
	}

	for _, action := range spec.Actions {
		entrypoint := action.Entrypoint
		if !filepath.IsAbs(entrypoint) {
			entrypoint = filepath.Join(moduleDir, entrypoint)
		}
		inputSchema, err := normalizeSchemaRef(action.InputSchema, moduleDir)
		if err != nil {
			return fmt.Errorf("legacy action %s input schema: %w", action.ID, err)
		}
		outputSchema, err := normalizeSchemaRef(action.OutputSchema, moduleDir)
		if err != nil {
			return fmt.Errorf("legacy action %s output schema: %w", action.ID, err)
		}

		r.Register(ActionDescriptor{
			Name:          action.ID,
			ModuleName:    spec.Provider,
			ModuleVersion: spec.Version,
			InputSchema:   inputSchema,
			OutputSchema:  outputSchema,
			Timeout:       30 * time.Second,
			Runtime: RuntimeRef{
				Type:       spec.Runtime,
				Entrypoint: entrypoint,
			},
		})
	}

	return nil
}
