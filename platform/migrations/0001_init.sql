-- torkflow platform control plane.
--
-- Runs are the high-volume table; everything else is configuration. Step rows
-- carry only what the timeline UI needs — full step payloads live in R2, keyed
-- by run and step, because a single step output can be megabytes.

CREATE TABLE tenants (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  -- Data residency is set at creation and never migrated in place; retrofitting
  -- it later means moving every downstream object.
  jurisdiction  TEXT NOT NULL DEFAULT 'global',
  created_at    INTEGER NOT NULL
);

CREATE TABLE api_keys (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  -- SHA-256 of the key. The key itself is shown once, at creation.
  key_hash    TEXT NOT NULL UNIQUE,
  scopes      TEXT NOT NULL DEFAULT 'run:read,run:write',
  created_at  INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at  INTEGER
);
CREATE INDEX idx_api_keys_tenant ON api_keys(tenant_id);

CREATE TABLE workflows (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- metadata.name from the YAML; unique per tenant.
  name        TEXT NOT NULL,
  description TEXT,
  -- The version currently used by triggers and by runs that do not pin one.
  live_version_id TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  archived_at INTEGER,
  UNIQUE (tenant_id, name)
);

-- Versions are immutable and content-addressed: a run pins a digest, so the
-- definition it executed can always be reproduced exactly.
CREATE TABLE workflow_versions (
  id            TEXT PRIMARY KEY,
  workflow_id   TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL,
  -- SHA-256 of the bundle; also its R2 key prefix.
  digest        TEXT NOT NULL,
  -- Parsed spec, cached so a run does not re-parse YAML on every start.
  spec_json     TEXT NOT NULL,
  source_yaml   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'draft',  -- draft | published
  created_by    TEXT,
  created_at    INTEGER NOT NULL,
  published_at  INTEGER,
  UNIQUE (workflow_id, version)
);
CREATE INDEX idx_versions_digest ON workflow_versions(digest);

CREATE TABLE connections (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- The name workflow steps reference via `connection: <name>`.
  name           TEXT NOT NULL,
  -- Must match the action's declared credentialType.
  type           TEXT NOT NULL,
  -- AES-GCM ciphertext of the credential payload, wrapped by the tenant DEK.
  -- Plaintext never lands in this table.
  secret_cipher  BLOB NOT NULL,
  secret_iv      BLOB NOT NULL,
  -- Which tenant key version encrypted it, so rotation can re-wrap lazily.
  key_version    INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  last_used_at   INTEGER,
  UNIQUE (tenant_id, name)
);

-- Per-tenant data encryption key, itself wrapped by the account-level KEK held
-- in the Workers Secrets Store.
CREATE TABLE tenant_keys (
  tenant_id    TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key_version  INTEGER NOT NULL,
  wrapped_dek  BLOB NOT NULL,
  wrap_iv      BLOB NOT NULL,
  created_at   INTEGER NOT NULL,
  retired_at   INTEGER,
  PRIMARY KEY (tenant_id, key_version)
);

CREATE TABLE runs (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workflow_id     TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  version_id      TEXT NOT NULL REFERENCES workflow_versions(id),
  -- The Workflows instance backing this run.
  instance_id     TEXT,
  status          TEXT NOT NULL,  -- queued | running | waiting | success | failed | cancelled
  -- manual | api | schedule | webhook | replay
  trigger_type    TEXT NOT NULL,
  trigger_ref     TEXT,
  trigger_input   TEXT,
  outputs         TEXT,
  error           TEXT,
  -- Set when this run resumes another.
  resumed_from    TEXT REFERENCES runs(id),
  created_at      INTEGER NOT NULL,
  started_at      INTEGER,
  ended_at        INTEGER,
  duration_ms     INTEGER
);
CREATE INDEX idx_runs_tenant_created ON runs(tenant_id, created_at DESC);
CREATE INDEX idx_runs_workflow_created ON runs(workflow_id, created_at DESC);
CREATE INDEX idx_runs_status ON runs(tenant_id, status, created_at DESC);

CREATE TABLE run_steps (
  run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL,  -- running | waiting | success | failed | skipped
  attempt     INTEGER NOT NULL DEFAULT 1,
  branch      TEXT,
  error       TEXT,
  -- R2 keys, set when the payload was too large to keep inline.
  input_ref   TEXT,
  output_ref  TEXT,
  input_json  TEXT,
  output_json TEXT,
  started_at  INTEGER,
  ended_at    INTEGER,
  duration_ms INTEGER,
  PRIMARY KEY (run_id, name)
);

CREATE TABLE run_logs (
  run_id     TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  ts         INTEGER NOT NULL,
  line       TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);

-- One row per schedule or webhook. A schedule's timing is driven by a Durable
-- Object alarm; the cron sweeper only catches alarms that were missed.
CREATE TABLE triggers (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workflow_id   TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,  -- schedule | webhook
  name          TEXT,
  enabled       INTEGER NOT NULL DEFAULT 1,
  cron          TEXT,
  timezone      TEXT DEFAULT 'UTC',
  -- Webhook: the path segment, and the HMAC secret used to verify deliveries.
  webhook_token TEXT UNIQUE,
  webhook_secret BLOB,
  input_json    TEXT,
  next_run_at   INTEGER,
  last_run_at   INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_triggers_due ON triggers(enabled, next_run_at);
CREATE INDEX idx_triggers_workflow ON triggers(workflow_id);

-- Pending human approvals, so the UI can list what is waiting without walking
-- every running instance.
CREATE TABLE approvals (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_name    TEXT NOT NULL,
  title        TEXT,
  description  TEXT,
  approvers    TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected | timed_out
  decided_by   TEXT,
  comment      TEXT,
  created_at   INTEGER NOT NULL,
  decided_at   INTEGER,
  UNIQUE (run_id, step_name)
);
CREATE INDEX idx_approvals_pending ON approvals(status, created_at DESC);

-- Append-only. Never updated, never deleted by the application.
CREATE TABLE audit_log (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  subject     TEXT NOT NULL,
  detail      TEXT,
  ts          INTEGER NOT NULL
);
CREATE INDEX idx_audit_tenant_ts ON audit_log(tenant_id, ts DESC);
