ALTER TABLE sessions ADD COLUMN usage_json TEXT;
--> statement-breakpoint
CREATE UNIQUE INDEX configuration_model_rate_revision_idx ON configuration_records (
  tenant, json_extract(settings_json, '$.provider'), json_extract(settings_json, '$.model'),
  json_extract(settings_json, '$.effectiveAt'), json_extract(settings_json, '$.revision')
) WHERE kind = 'model_rate_table';
