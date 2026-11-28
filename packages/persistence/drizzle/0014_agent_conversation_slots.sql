ALTER TABLE run_workspace_metadata ADD COLUMN generation TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE run_workspace_metadata ADD COLUMN enrollment_proof TEXT;
--> statement-breakpoint
UPDATE run_workspace_metadata SET generation = lower(hex(randomblob(16))) WHERE generation = '';
--> statement-breakpoint
CREATE TABLE agent_conversation_slots (
  tenant TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step TEXT NOT NULL CHECK (step IN ('spec.author', 'implementation.build')),
  role TEXT NOT NULL CHECK (role IN ('implementer', 'reviewer')),
  workspace_generation TEXT NOT NULL,
  storage_scope TEXT,
  compatibility_digest TEXT,
  scope_digest TEXT,
  pr_identity TEXT,
  native_handle TEXT,
  adapter_metadata TEXT CHECK (adapter_metadata IS NULL OR json_valid(adapter_metadata)),
  completed_attempt_id TEXT,
  claiming_attempt_id TEXT,
  latest_attempt_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('ready', 'in_flight', 'retired')),
  version INTEGER NOT NULL CHECK (version > 0),
  PRIMARY KEY (tenant, run_id, step, role),
  CHECK (state <> 'ready' OR (native_handle IS NOT NULL AND completed_attempt_id IS NOT NULL
    AND storage_scope IS NOT NULL AND compatibility_digest IS NOT NULL AND scope_digest IS NOT NULL)),
  CHECK (state <> 'in_flight' OR claiming_attempt_id IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE reviewed_dispatch_attempts (
  dispatch_order INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  tenant TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  occurrence_id TEXT NOT NULL,
  step TEXT NOT NULL CHECK (step IN ('spec.author', 'implementation.build')),
  role TEXT NOT NULL CHECK (role IN ('implementer', 'reviewer')),
  round INTEGER NOT NULL CHECK (round > 0),
  launch_json TEXT CHECK (launch_json IS NULL OR json_valid(launch_json)),
  decision TEXT NOT NULL CHECK (decision IN ('fresh', 'resume', 'fallback', 'retention_disallowed')),
  CHECK (length(id) > 0)
);
--> statement-breakpoint
CREATE INDEX reviewed_dispatch_latest_idx
ON reviewed_dispatch_attempts (tenant, run_id, step, role, dispatch_order);
