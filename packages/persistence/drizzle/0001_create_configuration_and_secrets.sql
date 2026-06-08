CREATE TABLE `configuration_records` (
  `id` text PRIMARY KEY NOT NULL,
  `kind` text NOT NULL,
  `provider_kind` text NOT NULL,
  `adapter_id` text NOT NULL,
  `settings_json` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `secret_store_metadata` (
  `id` text PRIMARY KEY NOT NULL,
  `encryption_version` text NOT NULL,
  `kdf_name` text NOT NULL,
  `kdf_params_json` text NOT NULL,
  `kdf_salt` text NOT NULL,
  `sentinel_nonce` text NOT NULL,
  `sentinel_ciphertext` text NOT NULL,
  `sentinel_auth_tag` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `secrets` (
  `handle` text PRIMARY KEY NOT NULL,
  `ciphertext` text NOT NULL,
  `nonce` text NOT NULL,
  `auth_tag` text NOT NULL,
  `encryption_version` text NOT NULL,
  `created_at` text NOT NULL
);
