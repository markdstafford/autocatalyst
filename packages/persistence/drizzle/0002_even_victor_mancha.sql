CREATE TABLE `artifacts` (
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
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `artifacts_run_created_idx` ON `artifacts` (`run_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`owner_json` text NOT NULL,
	`tenant` text NOT NULL,
	`title` text NOT NULL,
	`channel_json` text,
	`active_topic_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `conversations_project_created_idx` ON `conversations` (`project_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `feedback` (
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
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `feedback_run_status_idx` ON `feedback` (`run_id`,`status`);--> statement-breakpoint
CREATE INDEX `feedback_run_target_idx` ON `feedback` (`run_id`,`target`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`topic_id` text NOT NULL,
	`owner_json` text NOT NULL,
	`tenant` text NOT NULL,
	`author_json` text NOT NULL,
	`direction` text NOT NULL,
	`body` text NOT NULL,
	`intent` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `messages_topic_created_idx` ON `messages` (`topic_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_json` text NOT NULL,
	`tenant` text NOT NULL,
	`display_name` text NOT NULL,
	`repo_url` text NOT NULL,
	`host_repository_json` text NOT NULL,
	`workspace_root_override` text,
	`issue_tracker_setting_json` text,
	`code_host_setting_json` text,
	`credential_refs_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `publications` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`owner_json` text NOT NULL,
	`tenant` text NOT NULL,
	`provider` text NOT NULL,
	`url` text NOT NULL,
	`label` text NOT NULL,
	`fronted_resource_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `publications_run_created_idx` ON `publications` (`run_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `pull_requests` (
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
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pull_requests_one_per_run` ON `pull_requests` (`run_id`);--> statement-breakpoint
CREATE TABLE `run_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`phase` text,
	`step` text NOT NULL,
	`role` text NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text,
	`duration_ms` integer,
	`occurrence_json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `run_steps_run_started_idx` ON `run_steps` (`run_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `runs` (
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
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `runs_topic_created_idx` ON `runs` (`topic_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `runs_one_active_per_topic` ON `runs` (`topic_id`) WHERE "runs"."terminal" = 0;--> statement-breakpoint
CREATE TABLE `sessions` (
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
	`cost_json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sessions_run_started_idx` ON `sessions` (`run_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `sessions_run_step_role_idx` ON `sessions` (`run_id`,`step`,`role`);--> statement-breakpoint
CREATE TABLE `test_results` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`tester_json` text NOT NULL,
	`outcome` text NOT NULL,
	`evidence_json` text,
	`feedback_refs_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `test_results_run_created_idx` ON `test_results` (`run_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `topics` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`owner_json` text NOT NULL,
	`tenant` text NOT NULL,
	`title` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `topics_conversation_created_idx` ON `topics` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `topics_one_main_per_conversation` ON `topics` (`conversation_id`) WHERE "topics"."kind" = 'main';