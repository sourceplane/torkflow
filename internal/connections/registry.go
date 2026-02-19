package connections

import (
	"os"

	"gopkg.in/yaml.v3"
)

type Registry struct {
	items map[string]Connection
}

type registryFile struct {
	Connections []Connection `yaml:"connections"`
}

func NewRegistry() *Registry {
	return &Registry{items: map[string]Connection{}}
}

func LoadRegistry(path string) (*Registry, error) {
	reg := NewRegistry()
	if path == "" {
		return reg, nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return reg, nil
		}
		return nil, err
	}

	var file registryFile
	if err := yaml.Unmarshal(data, &file); err != nil {
		return nil, err
	}
	for _, c := range file.Connections {
		if c.Name == "" {
			continue
		}
		reg.items[c.Name] = c
	}
	return reg, nil
}

func (r *Registry) Get(name string) (Connection, bool) {
	conn, ok := r.items[name]
	return conn, ok
}
