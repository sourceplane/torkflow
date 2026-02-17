package registry

import (
	"fmt"
	"os"
	"path/filepath"

	"gopkg.in/yaml.v3"
)

type ProviderSpec struct {
	Provider string       `yaml:"provider"`
	Version  string       `yaml:"version"`
	Runtime  string       `yaml:"runtime"`
	Actions  []ActionSpec `yaml:"actions"`
}

type ActionSpec struct {
	ID           string `yaml:"id"`
	Entrypoint   string `yaml:"entrypoint"`
	InputSchema  string `yaml:"inputSchema"`
	OutputSchema string `yaml:"outputSchema"`
}

type ActionDescriptor struct {
	ID         string
	Entrypoint string
	Provider   string
	Runtime    string
}

type Registry struct {
	Actions map[string]ActionDescriptor
}

func NewRegistry() *Registry {
	return &Registry{Actions: map[string]ActionDescriptor{}}
}

func (r *Registry) Register(action ActionDescriptor) {
	r.Actions[action.ID] = action
}

func (r *Registry) Get(id string) (ActionDescriptor, bool) {
	action, ok := r.Actions[id]
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
		specPath := filepath.Join(dir, entry.Name(), "provider.yaml")
		data, err := os.ReadFile(specPath)
		if err != nil {
			continue
		}
		var spec ProviderSpec
		if err := yaml.Unmarshal(data, &spec); err != nil {
			return fmt.Errorf("provider %s: %w", entry.Name(), err)
		}
		for _, action := range spec.Actions {
			entrypoint := action.Entrypoint
			if !filepath.IsAbs(entrypoint) {
				entrypoint = filepath.Join(dir, entry.Name(), entrypoint)
			}
			r.Register(ActionDescriptor{
				ID:         action.ID,
				Entrypoint: entrypoint,
				Provider:   spec.Provider,
				Runtime:    spec.Runtime,
			})
		}
	}
	return nil
}
