package connections

type Connection struct {
	Name      string `yaml:"name"`
	Type      string `yaml:"type"`
	SecretRef string `yaml:"secretRef"`
}

type SecretStore interface {
	Get(secretRef string) (map[string]any, error)
}
