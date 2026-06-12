CREATE TABLE `run_workspace_metadata` (
  `run_id` text PRIMARY KEY NOT NULL REFERENCES `runs`(`id`),
  `workspace_handle` text NOT NULL,
  `workspace_repo_root` text NOT NULL,
  `created_at` text NOT NULL
);
