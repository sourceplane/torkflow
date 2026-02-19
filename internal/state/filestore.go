package state

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

type FileStore struct {
	Root string
}

func NewFileStore(root string) *FileStore {
	return &FileStore{Root: root}
}

func (f *FileStore) Init(metadata Metadata, st State, ctx map[string]any) error {
	if err := os.MkdirAll(filepath.Join(f.Root, "steps"), 0o755); err != nil {
		return err
	}
	if err := f.writeJSON("metadata.json", metadata); err != nil {
		return err
	}
	if err := f.SaveState(st); err != nil {
		return err
	}
	return f.SaveContext(ctx)
}

func (f *FileStore) LoadMetadata() (Metadata, error) {
	var m Metadata
	return m, f.readJSON("metadata.json", &m)
}

func (f *FileStore) LoadState() (State, error) {
	var st State
	return st, f.readJSON("state.json", &st)
}

func (f *FileStore) LoadContext() (map[string]any, error) {
	var ctx map[string]any
	return ctx, f.readJSON("context.json", &ctx)
}

func (f *FileStore) SaveState(st State) error {
	return f.writeJSON("state.json", st)
}

func (f *FileStore) SaveContext(ctx map[string]any) error {
	return f.writeJSON("context.json", ctx)
}

func (f *FileStore) SaveStep(record StepRecord) error {
	file := filepath.Join(f.Root, "steps", fmt.Sprintf("%s.json", record.Name))
	data, err := json.MarshalIndent(record, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(file, data, 0o644)
}

func (f *FileStore) AppendRunError(entry RunError) error {
	data, err := json.Marshal(entry)
	if err != nil {
		return err
	}
	file := filepath.Join(f.Root, "errors.log")
	fd, err := os.OpenFile(file, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer fd.Close()
	if _, err := fd.Write(append(data, '\n')); err != nil {
		return err
	}
	return nil
}

func (f *FileStore) writeJSON(name string, v any) error {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(f.Root, name), data, 0o644)
}

func (f *FileStore) readJSON(name string, v any) error {
	data, err := os.ReadFile(filepath.Join(f.Root, name))
	if err != nil {
		return err
	}
	return json.Unmarshal(data, v)
}
