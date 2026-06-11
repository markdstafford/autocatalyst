CREATE TABLE `configuration_records_new` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant` text NOT NULL,
  `kind` text NOT NULL,
  `provider_kind` text,
  `adapter_id` text,
  `settings_json` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `configuration_records_new` (`id`, `tenant`, `kind`, `provider_kind`, `adapter_id`, `settings_json`, `created_at`, `updated_at`)
SELECT `id`, 'tenant_dev', `kind`, `provider_kind`, `adapter_id`, `settings_json`, `created_at`, `updated_at`
FROM `configuration_records`;
--> statement-breakpoint
DROP TABLE `configuration_records`;
--> statement-breakpoint
ALTER TABLE `configuration_records_new` RENAME TO `configuration_records`;
--> statement-breakpoint
CREATE INDEX `configuration_records_tenant_kind_idx` ON `configuration_records` (`tenant`, `kind`);
