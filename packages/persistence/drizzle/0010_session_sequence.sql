ALTER TABLE `sessions` ADD `sequence` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `sessions` SET `sequence` = (
	SELECT COUNT(*) FROM `sessions` AS `s2`
	WHERE `s2`.`run_id` = `sessions`.`run_id`
		AND (`s2`.`started_at` < `sessions`.`started_at`
			OR (`s2`.`started_at` = `sessions`.`started_at` AND `s2`.`id` <= `sessions`.`id`))
);--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_run_sequence_idx` ON `sessions` (`run_id`,`sequence`);
