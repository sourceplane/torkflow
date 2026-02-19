package connections

import (
	"fmt"
	"os"

	"gopkg.in/yaml.v3"
)

type FileSecretStore struct {
	secrets map[string]map[string]any
}

type secretsEnvelope struct {
	Secrets map[string]map[string]any `yaml:"secrets"`
}

func LoadFileSecretStore(path string) (*FileSecretStore, error) {
	store := &FileSecretStore{secrets: map[string]map[string]any{}}
	if path == "" {
		return store, nil
	}

	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return store, nil
		}
		return nil, err
	}

	var env secretsEnvelope
	if err := yaml.Unmarshal(data, &env); err == nil && len(env.Secrets) > 0 {
		store.secrets = env.Secrets
		return store, nil
	}

	var raw map[string]map[string]any
	if err := yaml.Unmarshal(data, &raw); err != nil {
		return nil, err
	}
	store.secrets = raw
	return store, nil
}

func (s *FileSecretStore) Get(secretRef string) (map[string]any, error) {
	if secretRef == "" {
		return map[string]any{}, nil
	}
	secret, ok := s.secrets[secretRef]
	if !ok {
		return nil, fmt.Errorf("secretRef %q not found", secretRef)
	}
	clone := map[string]any{}
	for k, v := range secret {
		clone[k] = v
	}
	return clone, nil
}
