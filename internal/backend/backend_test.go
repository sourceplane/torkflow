package backend

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"torkflow/internal/engine"
	"torkflow/internal/registry"
	"torkflow/internal/workflow"
)

const contractDir = "contract/v1"

// TestContractManifest — the vendored contract may not drift from the manifest.
// The same files (and manifest) are vendored in sourceplane/orun; changing the
// contract means changing both repos in lockstep, or cutting contract/v2.
func TestContractManifest(t *testing.T) {
	manifest, err := os.ReadFile(filepath.Join(contractDir, "MANIFEST.sha256"))
	if err != nil {
		t.Fatalf("read manifest: %v", err)
	}
	want := map[string]string{}
	for _, line := range strings.Split(strings.TrimSpace(string(manifest)), "\n") {
		parts := strings.Fields(line)
		if len(parts) != 2 {
			t.Fatalf("malformed manifest line: %q", line)
		}
		want[parts[1]] = parts[0]
	}
	got := map[string]string{}
	err = filepath.Walk(contractDir, func(path string, info os.FileInfo, werr error) error {
		if werr != nil || info.IsDir() || filepath.Base(path) == "MANIFEST.sha256" {
			return werr
		}
		data, rerr := os.ReadFile(path)
		if rerr != nil {
			return rerr
		}
		rel, _ := filepath.Rel(contractDir, path)
		got[filepath.ToSlash(rel)] = fmt.Sprintf("%x", sha256.Sum256(data))
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for n := range got {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		if want[n] == "" {
			t.Errorf("contract file %s not in MANIFEST.sha256", n)
		} else if want[n] != got[n] {
			t.Errorf("contract file %s diverges from the vendored manifest", n)
		}
	}
	for n := range want {
		if got[n] == "" {
			t.Errorf("manifest names %s but the file is missing", n)
		}
	}
}

// TestFixturesRoundTrip — this repo's Go types agree with the vendored fixtures.
func TestFixturesRoundTrip(t *testing.T) {
	for _, name := range []string{"request-minimal.json", "request-full.json"} {
		data, err := os.ReadFile(filepath.Join(contractDir, "fixtures", name))
		if err != nil {
			t.Fatal(err)
		}
		dec := json.NewDecoder(bytes.NewReader(data))
		dec.DisallowUnknownFields()
		var req Request
		if err := dec.Decode(&req); err != nil {
			t.Fatalf("%s: Request cannot decode fixture: %v", name, err)
		}
		if req.Contract != ContractV1 {
			t.Fatalf("%s: wrong contract %q", name, req.Contract)
		}
	}
	for _, name := range []string{"response-success.json", "response-failed.json", "response-paused.json"} {
		data, err := os.ReadFile(filepath.Join(contractDir, "fixtures", name))
		if err != nil {
			t.Fatal(err)
		}
		dec := json.NewDecoder(bytes.NewReader(data))
		dec.DisallowUnknownFields()
		var res Response
		if err := dec.Decode(&res); err != nil {
			t.Fatalf("%s: Response cannot decode fixture: %v", name, err)
		}
	}
}

// coreWorkflow is a two-step workflow using only built-in core actions, so the
// end-to-end test needs no provider binaries.
const coreWorkflow = `apiVersion: torkflow/v1
kind: Workflow
metadata:
  name: backend-e2e
spec:
  steps:
    - name: First
      actionRef: core.stdout
      parameters:
        title: first
      outboundEdges:
        - nextStepName: Second
    - name: Second
      actionRef: core.stdout
      parameters:
        title: second
`

func TestBackendEndToEnd(t *testing.T) {
	dir := t.TempDir()
	wf := filepath.Join(dir, "wf.yaml")
	if err := os.WriteFile(wf, []byte(coreWorkflow), 0o644); err != nil {
		t.Fatal(err)
	}

	req, _ := json.Marshal(Request{
		Contract: ContractV1,
		Workflow: wf,
		With:     map[string]any{"who": "backend-test"},
		RunDir:   filepath.Join(dir, "runs"),
	})
	var out bytes.Buffer
	code := Run(bytes.NewReader(req), &out)
	if code != 0 {
		t.Fatalf("backend exit=%d, output=%s", code, out.String())
	}
	var res Response
	if err := json.Unmarshal(out.Bytes(), &res); err != nil {
		t.Fatalf("response not JSON: %v (%s)", err, out.String())
	}
	if res.Contract != ContractV1 || res.Status != "success" {
		t.Fatalf("unexpected response: %+v", res)
	}
	if len(res.Steps) != 2 || res.Steps[0].Name != "First" || res.Steps[0].Status != "success" {
		t.Fatalf("timeline wrong: %+v", res.Steps)
	}
}

const outputsWorkflow = `apiVersion: torkflow/v1
kind: Workflow
metadata:
  name: outputs-e2e
spec:
  outputs:
    sum: "{{ Steps.Calc.result }}"
    who: "{{ Trigger.who }}"
  steps:
    - name: Calc
      actionRef: core.js
      parameters:
        script: "20 + 22"
`

func TestBackendEvaluatesDeclaredOutputsOnly(t *testing.T) {
	dir := t.TempDir()
	wf := filepath.Join(dir, "wf.yaml")
	if err := os.WriteFile(wf, []byte(outputsWorkflow), 0o644); err != nil {
		t.Fatal(err)
	}
	req, _ := json.Marshal(Request{
		Contract: ContractV1,
		Workflow: wf,
		With:     map[string]any{"who": "wx4"},
		RunDir:   filepath.Join(dir, "runs"),
	})
	var out bytes.Buffer
	if code := Run(bytes.NewReader(req), &out); code != 0 {
		t.Fatalf("backend exit=%d output=%s", code, out.String())
	}
	var res Response
	if err := json.Unmarshal(out.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	if res.Outputs["sum"] != "42" || res.Outputs["who"] != "wx4" {
		t.Fatalf("declared outputs not evaluated: %#v", res.Outputs)
	}
	if len(res.Outputs) != 2 {
		t.Fatalf("ONLY declared outputs may cross: %#v", res.Outputs)
	}
	// The raw context (Steps.*) must not appear anywhere in the response.
	if strings.Contains(out.String(), "\"Steps\"") || strings.Contains(out.String(), "\"Trigger\"") {
		t.Fatalf("raw context leaked into the response: %s", out.String())
	}
}

func TestBackendFailurePropagates(t *testing.T) {
	dir := t.TempDir()
	wf := filepath.Join(dir, "wf.yaml")
	bad := strings.Replace(coreWorkflow, "core.stdout", "no.such.action", 1)
	if err := os.WriteFile(wf, []byte(bad), 0o644); err != nil {
		t.Fatal(err)
	}
	req, _ := json.Marshal(Request{Contract: ContractV1, Workflow: wf, RunDir: filepath.Join(dir, "runs")})
	var out bytes.Buffer
	code := Run(bytes.NewReader(req), &out)
	if code == 0 {
		t.Fatalf("expected non-zero exit for a failed workflow")
	}
	var res Response
	if err := json.Unmarshal(out.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	if res.Status != "failed" || res.Error == "" {
		t.Fatalf("expected structured failure, got %+v", res)
	}
}

func TestBackendRejectsUnknownContract(t *testing.T) {
	var out bytes.Buffer
	code := Run(strings.NewReader(`{"contract":"v9","workflow":"x.yaml"}`), &out)
	if code == 0 || !strings.Contains(out.String(), "unsupported contract") {
		t.Fatalf("expected versioned rejection, got exit=%d output=%s", code, out.String())
	}
	if !strings.Contains(out.String(), `"contract":"v1"`) {
		t.Fatalf("rejection must state the contract this engine speaks: %s", out.String())
	}
}

// TestInjectedCredentialsAreExclusive — with injected credentials, a step's
// connection resolves from the request payloads only; an unprovided connection
// fails closed rather than consulting files.
func TestInjectedCredentialsAreExclusive(t *testing.T) {
	eng := &engine.Engine{
		InjectedCredentials: map[string]map[string]any{
			"vcs-app": {"token": "t0ken"},
		},
	}
	cred, err := eng.ResolveCredential(workflow.Step{Name: "s", Connection: "vcs-app"}, registry.ActionDescriptor{})
	if err != nil || cred["token"] != "t0ken" {
		t.Fatalf("injected credential not resolved: %v %v", cred, err)
	}
	if _, err := eng.ResolveCredential(workflow.Step{Name: "s", Connection: "absent"}, registry.ActionDescriptor{}); err == nil {
		t.Fatalf("an unprovided connection must fail closed")
	}
}

func TestCoerceConnections(t *testing.T) {
	got := coerceConnections(map[string]any{
		"a": map[string]any{"token": "x"},
		"b": "bare-token",
	})
	if got["a"]["token"] != "x" || got["b"]["value"] != "bare-token" {
		t.Fatalf("unexpected coercion: %#v", got)
	}
}
