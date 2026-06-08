PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`owner_json` text NOT NULL,
	`tenant` text NOT NULL,
	`kind` text NOT NULL,
	`canonical_record` text NOT NULL,
	`location` text NOT NULL,
	`cached_status` text NOT NULL,
	`linked_issue_json` text,
	`publication_refs_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_artifacts`("id", "run_id", "owner_json", "tenant", "kind", "canonical_record", "location", "cached_status", "linked_issue_json", "publication_refs_json", "created_at", "updated_at") SELECT "id", "run_id", "owner_json", "tenant", "kind", "canonical_record", "location", "cached_status", "linked_issue_json", "publication_refs_json", "created_at", "updated_at" FROM `artifacts`;--> statement-breakpoint
DROP TABLE `artifacts`;--> statement-breakpoint
ALTER TABLE `__new_artifacts` RENAME TO `artifacts`;--> statement-breakpoint
CREATE INDEX `artifacts_run_created_idx` ON `artifacts` (`run_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `__new_conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`owner_json` text NOT NULL,
	`tenant` text NOT NULL,
	`identity` text NOT NULL,
	`channel_json` text,
	`active_topic_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`active_topic_id`) REFERENCES `topics`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_conversations`("id", "project_id", "owner_json", "tenant", "identity", "channel_json", "active_topic_id", "created_at", "updated_at") SELECT "id", "project_id", "owner_json", "tenant", "identity", "channel_json", "active_topic_id", "created_at", "updated_at" FROM `conversations`;--> statement-breakpoint
DROP TABLE `conversations`;--> statement-breakpoint
ALTER TABLE `__new_conversations` RENAME TO `conversations`;--> statement-breakpoint
CREATE INDEX `conversations_project_created_idx` ON `conversations` (`project_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `__new_feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`owner_json` text NOT NULL,
	`tenant` text NOT NULL,
	`target` text NOT NULL,
	`status` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`anchor_json` text,
	`thread_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_feedback`("id", "run_id", "owner_json", "tenant", "target", "status", "title", "body", "anchor_json", "thread_json", "created_at", "updated_at") SELECT "id", "run_id", "owner_json", "tenant", "target", "status", "title", "body", "anchor_json", "thread_json", "created_at", "updated_at" FROM `feedback`;--> statement-breakpoint
DROP TABLE `feedback`;--> statement-breakpoint
ALTER TABLE `__new_feedback` RENAME TO `feedback`;--> statement-breakpoint
CREATE INDEX `feedback_run_status_idx` ON `feedback` (`run_id`,`status`);--> statement-breakpoint
CREATE INDEX `feedback_run_target_idx` ON `feedback` (`run_id`,`target`);--> statement-breakpoint
CREATE TABLE `__new_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`topic_id` text NOT NULL,
	`owner_json` text NOT NULL,
	`tenant` text NOT NULL,
	`author_json` text NOT NULL,
	`direction` text NOT NULL,
	`body` text NOT NULL,
	`intent` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`topic_id`) REFERENCES `topics`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_messages`("id", "topic_id", "owner_json", "tenant", "author_json", "direction", "body", "intent", "created_at") SELECT "id", "topic_id", "owner_json", "tenant", "author_json", "direction", "body", "intent", "created_at" FROM `messages`;--> statement-breakpoint
DROP TABLE `messages`;--> statement-breakpoint
ALTER TABLE `__new_messages` RENAME TO `messages`;--> statement-breakpoint
CREATE INDEX `messages_topic_created_idx` ON `messages` (`topic_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `__new_publications` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`owner_json` text NOT NULL,
	`tenant` text NOT NULL,
	`provider` text NOT NULL,
	`url` text NOT NULL,
	`label` text NOT NULL,
	`fronted_resource_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_publications`("id", "run_id", "owner_json", "tenant", "provider", "url", "label", "fronted_resource_json", "created_at", "updated_at") SELECT "id", "run_id", "owner_json", "tenant", "provider", "url", "label", "fronted_resource_json", "created_at", "updated_at" FROM `publications`;--> statement-breakpoint
DROP TABLE `publications`;--> statement-breakpoint
ALTER TABLE `__new_publications` RENAME TO `publications`;--> statement-breakpoint
CREATE INDEX `publications_run_created_idx` ON `publications` (`run_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `__new_pull_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`owner_json` text NOT NULL,
	`tenant` text NOT NULL,
	`provider` text NOT NULL,
	`number` integer NOT NULL,
	`url` text NOT NULL,
	`state` text NOT NULL,
	`branch` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_pull_requests`("id", "run_id", "owner_json", "tenant", "provider", "number", "url", "state", "branch", "created_at", "updated_at") SELECT "id", "run_id", "owner_json", "tenant", "provider", "number", "url", "state", "branch", "created_at", "updated_at" FROM `pull_requests`;--> statement-breakpoint
DROP TABLE `pull_requests`;--> statement-breakpoint
ALTER TABLE `__new_pull_requests` RENAME TO `pull_requests`;--> statement-breakpoint
CREATE UNIQUE INDEX `pull_requests_one_per_run` ON `pull_requests` (`run_id`);--> statement-breakpoint
CREATE TABLE `__new_run_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`phase` text,
	`step` text NOT NULL,
	`role` text NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text,
	`duration_ms` integer,
	`occurrence_json` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_run_steps`("id", "run_id", "phase", "step", "role", "started_at", "ended_at", "duration_ms", "occurrence_json") SELECT "id", "run_id", "phase", "step", "role", "started_at", "ended_at", "duration_ms", "occurrence_json" FROM `run_steps`;--> statement-breakpoint
DROP TABLE `run_steps`;--> statement-breakpoint
ALTER TABLE `__new_run_steps` RENAME TO `run_steps`;--> statement-breakpoint
CREATE INDEX `run_steps_run_started_idx` ON `run_steps` (`run_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `__new_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`topic_id` text NOT NULL,
	`owner_json` text NOT NULL,
	`tenant` text NOT NULL,
	`work_kind` text NOT NULL,
	`current_step` text NOT NULL,
	`terminal` integer NOT NULL,
	`tracked_issue_json` text,
	`testing_guide_result_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`topic_id`) REFERENCES `topics`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_runs`("id", "topic_id", "owner_json", "tenant", "work_kind", "current_step", "terminal", "tracked_issue_json", "testing_guide_result_json", "created_at", "updated_at") SELECT "id", "topic_id", "owner_json", "tenant", "work_kind", "current_step", "terminal", "tracked_issue_json", "testing_guide_result_json", "created_at", "updated_at" FROM `runs`;--> statement-breakpoint
DROP TABLE `runs`;--> statement-breakpoint
ALTER TABLE `__new_runs` RENAME TO `runs`;--> statement-breakpoint
CREATE INDEX `runs_topic_created_idx` ON `runs` (`topic_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `runs_one_active_per_topic` ON `runs` (`topic_id`) WHERE "runs"."terminal" = 0;--> statement-breakpoint
CREATE TABLE `__new_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`phase` text,
	`step` text NOT NULL,
	`role` text NOT NULL,
	`round` integer NOT NULL,
	`model_json` text NOT NULL,
	`inference_settings_json` text NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text,
	`duration_ms` integer,
	`tokens_json` text NOT NULL,
	`usage_available` integer NOT NULL,
	`assistant_turn_count` integer NOT NULL,
	`tool_call_count` integer NOT NULL,
	`outcome` text NOT NULL,
	`cost_json` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_sessions`("id", "run_id", "phase", "step", "role", "round", "model_json", "inference_settings_json", "started_at", "ended_at", "duration_ms", "tokens_json", "usage_available", "assistant_turn_count", "tool_call_count", "outcome", "cost_json") SELECT "id", "run_id", "phase", "step", "role", "round", "model_json", "inference_settings_json", "started_at", "ended_at", "duration_ms", "tokens_json", "usage_available", "assistant_turn_count", "tool_call_count", "outcome", "cost_json" FROM `sessions`;--> statement-breakpoint
DROP TABLE `sessions`;--> statement-breakpoint
ALTER TABLE `__new_sessions` RENAME TO `sessions`;--> statement-breakpoint
CREATE INDEX `sessions_run_started_idx` ON `sessions` (`run_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `sessions_run_step_role_idx` ON `sessions` (`run_id`,`step`,`role`);--> statement-breakpoint
CREATE TABLE `__new_test_results` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`tester_json` text NOT NULL,
	`outcome` text NOT NULL,
	`evidence_json` text,
	`feedback_refs_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_test_results`("id", "run_id", "tester_json", "outcome", "evidence_json", "feedback_refs_json", "created_at", "updated_at") SELECT "id", "run_id", "tester_json", "outcome", "evidence_json", "feedback_refs_json", "created_at", "updated_at" FROM `test_results`;--> statement-breakpoint
DROP TABLE `test_results`;--> statement-breakpoint
ALTER TABLE `__new_test_results` RENAME TO `test_results`;--> statement-breakpoint
CREATE INDEX `test_results_run_created_idx` ON `test_results` (`run_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `__new_topics` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`owner_json` text NOT NULL,
	`tenant` text NOT NULL,
	`title` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_topics`("id", "conversation_id", "owner_json", "tenant", "title", "kind", "created_at", "updated_at") SELECT "id", "conversation_id", "owner_json", "tenant", "title", "kind", "created_at", "updated_at" FROM `topics`;--> statement-breakpoint
DROP TABLE `topics`;--> statement-breakpoint
ALTER TABLE `__new_topics` RENAME TO `topics`;--> statement-breakpoint
CREATE INDEX `topics_conversation_created_idx` ON `topics` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `topics_one_main_per_conversation` ON `topics` (`conversation_id`) WHERE "topics"."kind" = 'main';--> statement-breakpoint
PRAGMA foreign_keys=ON;
