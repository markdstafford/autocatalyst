CREATE TABLE `testing_guides` (
  `id` text PRIMARY KEY NOT NULL,
  `run_id` text NOT NULL REFERENCES `runs`(`id`),
  `tenant` text NOT NULL,
  `revision` integer NOT NULL,
  `run_step_id` text NOT NULL REFERENCES `run_steps`(`id`),
  `instructions` text NOT NULL,
  `items_json` text NOT NULL,
  `created_at` text NOT NULL,
  CONSTRAINT "testing_guides_revision_check" CHECK(typeof(`revision`) = 'integer' and `revision` >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `testing_guides_run_revision_idx` ON `testing_guides` (`run_id`, `revision`);
--> statement-breakpoint
CREATE UNIQUE INDEX `testing_guides_run_step_idx` ON `testing_guides` (`run_step_id`);
