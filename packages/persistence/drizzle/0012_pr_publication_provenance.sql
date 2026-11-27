ALTER TABLE `pull_requests` ADD `autocatalyst_head_sha` text;
--> statement-breakpoint
CREATE TABLE `pr_ci_repair_heads` (
  `pull_request_id` text NOT NULL REFERENCES `pull_requests`(`id`),
  `head_sha` text NOT NULL,
  `gate_step_id` text NOT NULL REFERENCES `run_steps`(`id`),
  `repair_step_id` text UNIQUE REFERENCES `run_steps`(`id`),
  `current_step_id` text REFERENCES `run_steps`(`id`),
  `outcome_step_id` text REFERENCES `run_steps`(`id`),
  `ordinal` integer CHECK (`ordinal` > 0),
  `limit_at_decision` integer NOT NULL CHECK (`limit_at_decision` >= 0),
  `admitted_count` integer NOT NULL CHECK (`admitted_count` >= 0),
  `state` text NOT NULL CHECK (`state` IN ('external', 'exhausted', 'queued', 'running', 'awaiting_human', 'publishing', 'pushed', 'stopped', 'superseded')),
  `base_ref` text NOT NULL,
  `failure_details_json` text NOT NULL,
  `owner_epoch` text,
  `publish_head_sha` text,
  `candidate_sha` text,
  `push_receipt_json` text,
  `refresh_count` integer NOT NULL DEFAULT 0 CHECK (`refresh_count` BETWEEN 0 AND 2),
  `stop_code` text,
  `workspace_hold` integer NOT NULL DEFAULT 0 CHECK (`workspace_hold` IN (0, 1)),
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  PRIMARY KEY (`pull_request_id`, `head_sha`),
  UNIQUE (`pull_request_id`, `ordinal`),
  CHECK ((`state` IN ('external', 'exhausted')) = (`ordinal` IS NULL)),
  CHECK ((`ordinal` IS NULL) = (`repair_step_id` IS NULL)),
  CHECK ((`state` IN ('queued', 'running', 'awaiting_human', 'publishing')) = (`current_step_id` IS NOT NULL)),
  CHECK ((`state` IN ('pushed', 'stopped', 'superseded')) = (`outcome_step_id` IS NOT NULL)),
  CHECK (`state` NOT IN ('running', 'publishing') OR `owner_epoch` IS NOT NULL),
  CHECK (`state` NOT IN ('queued', 'awaiting_human') OR `owner_epoch` IS NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pr_ci_repair_heads_one_active` ON `pr_ci_repair_heads`(`pull_request_id`)
  WHERE `state` IN ('queued', 'running', 'awaiting_human', 'publishing');
