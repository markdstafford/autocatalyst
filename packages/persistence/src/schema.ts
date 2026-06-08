import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const probeResources = sqliteTable('probe_resources', {
  id: text('id').primaryKey(),
  value: text('value').notNull(),
  createdAt: text('created_at').notNull()
});

export const configurationRecords = sqliteTable('configuration_records', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  providerKind: text('provider_kind').notNull(),
  adapterId: text('adapter_id').notNull(),
  settingsJson: text('settings_json').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
});

export const secretStoreMetadata = sqliteTable('secret_store_metadata', {
  id: text('id').primaryKey(),
  encryptionVersion: text('encryption_version').notNull(),
  kdfName: text('kdf_name').notNull(),
  kdfParamsJson: text('kdf_params_json').notNull(),
  kdfSalt: text('kdf_salt').notNull(),
  sentinelNonce: text('sentinel_nonce').notNull(),
  sentinelCiphertext: text('sentinel_ciphertext').notNull(),
  sentinelAuthTag: text('sentinel_auth_tag').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
});

export const secrets = sqliteTable('secrets', {
  handle: text('handle').primaryKey(),
  ciphertext: text('ciphertext').notNull(),
  nonce: text('nonce').notNull(),
  authTag: text('auth_tag').notNull(),
  encryptionVersion: text('encryption_version').notNull(),
  createdAt: text('created_at').notNull()
});
