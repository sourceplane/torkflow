package state

type Store interface {
	Init(metadata Metadata, state State, context map[string]any) error
	LoadMetadata() (Metadata, error)
	LoadState() (State, error)
	LoadContext() (map[string]any, error)
	SaveState(state State) error
	SaveContext(context map[string]any) error
	SaveStep(record StepRecord) error
	AppendRunError(entry RunError) error
}
