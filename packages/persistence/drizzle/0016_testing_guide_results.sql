ALTER TABLE test_results ADD COLUMN guide_revision integer
  CHECK (guide_revision IS NULL OR (typeof(guide_revision) = 'integer' AND guide_revision >= 1));
--> statement-breakpoint
ALTER TABLE test_results ADD COLUMN state text NOT NULL DEFAULT 'final'
  CHECK (state IN ('working', 'final'));
--> statement-breakpoint
ALTER TABLE test_results ADD COLUMN items_json text NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE test_results ADD COLUMN gate_step_id text REFERENCES run_steps(id)
  CHECK ((guide_revision IS NULL) = (gate_step_id IS NULL) AND (state = 'final' OR gate_step_id IS NOT NULL));
--> statement-breakpoint
CREATE UNIQUE INDEX test_results_working_run_idx ON test_results (run_id) WHERE state = 'working';
--> statement-breakpoint
CREATE UNIQUE INDEX test_results_gate_step_idx ON test_results (gate_step_id) WHERE gate_step_id IS NOT NULL;
