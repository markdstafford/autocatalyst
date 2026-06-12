import { sql } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const probeResources = sqliteTable('probe_resources', {
  id: text('id').primaryKey(),
  value: text('value').notNull(),
  createdAt: text('created_at').notNull()
});

export const configurationRecords = sqliteTable('configuration_records', {
  id: text('id').primaryKey(),
  tenant: text('tenant').notNull(),
  kind: text('kind').notNull(),
  providerKind: text('provider_kind'),        // nullable (routing tables have no provider)
  adapterId: text('adapter_id'),               // nullable
  settingsJson: text('settings_json').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
}, (table) => [
  index('configuration_records_tenant_kind_idx').on(table.tenant, table.kind)
]);

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

// Domain tables

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  ownerJson: text('owner_json').notNull(),
  tenant: text('tenant').notNull(),
  displayName: text('display_name').notNull(),
  repoUrl: text('repo_url').notNull(),
  hostRepositoryJson: text('host_repository_json').notNull(),
  workspaceRootOverride: text('workspace_root_override'),
  issueTrackerSettingJson: text('issue_tracker_setting_json'),
  codeHostSettingJson: text('code_host_setting_json'),
  credentialRefsJson: text('credential_refs_json').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
});

export const conversations = sqliteTable('conversations', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id),
  ownerJson: text('owner_json').notNull(),
  tenant: text('tenant').notNull(),
  identity: text('identity').notNull(),
  channelJson: text('channel_json'),
  activeTopicId: text('active_topic_id').references((): AnySQLiteColumn => topics.id),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
}, (table) => [
  index('conversations_project_created_idx').on(table.projectId, table.createdAt)
]);

export const topics = sqliteTable('topics', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id').notNull().references((): AnySQLiteColumn => conversations.id),
  ownerJson: text('owner_json').notNull(),
  tenant: text('tenant').notNull(),
  title: text('title').notNull(),
  kind: text('kind').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
}, (table) => [
  index('topics_conversation_created_idx').on(table.conversationId, table.createdAt),
  uniqueIndex('topics_one_main_per_conversation').on(table.conversationId).where(sql`${table.kind} = 'main'`)
]);

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  topicId: text('topic_id').notNull().references(() => topics.id),
  ownerJson: text('owner_json').notNull(),
  tenant: text('tenant').notNull(),
  authorJson: text('author_json').notNull(),
  direction: text('direction').notNull(),
  body: text('body').notNull(),
  intent: text('intent'),
  createdAt: text('created_at').notNull()
}, (table) => [
  index('messages_topic_created_idx').on(table.topicId, table.createdAt)
]);

export const runs = sqliteTable('runs', {
  id: text('id').primaryKey(),
  topicId: text('topic_id').notNull().references(() => topics.id),
  ownerJson: text('owner_json').notNull(),
  tenant: text('tenant').notNull(),
  workKind: text('work_kind').notNull(),
  currentStep: text('current_step').notNull(),
  terminal: integer('terminal', { mode: 'boolean' }).notNull(),
  trackedIssueJson: text('tracked_issue_json'),
  testingGuideResultJson: text('testing_guide_result_json'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
}, (table) => [
  index('runs_topic_created_idx').on(table.topicId, table.createdAt),
  uniqueIndex('runs_one_active_per_topic').on(table.topicId).where(sql`${table.terminal} = 0`)
]);

export const artifacts = sqliteTable('artifacts', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull().references(() => runs.id),
  ownerJson: text('owner_json').notNull(),
  tenant: text('tenant').notNull(),
  kind: text('kind').notNull(),
  canonicalRecord: text('canonical_record').notNull(),
  location: text('location').notNull(),
  cachedStatus: text('cached_status').notNull(),
  linkedIssueJson: text('linked_issue_json'),
  publicationRefsJson: text('publication_refs_json').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
}, (table) => [
  index('artifacts_run_created_idx').on(table.runId, table.createdAt)
]);

export const feedback = sqliteTable('feedback', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull().references(() => runs.id),
  ownerJson: text('owner_json').notNull(),
  tenant: text('tenant').notNull(),
  target: text('target').notNull(),
  status: text('status').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  anchorJson: text('anchor_json'),
  threadJson: text('thread_json').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
}, (table) => [
  index('feedback_run_status_idx').on(table.runId, table.status),
  index('feedback_run_target_idx').on(table.runId, table.target)
]);

export const publications = sqliteTable('publications', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull().references(() => runs.id),
  ownerJson: text('owner_json').notNull(),
  tenant: text('tenant').notNull(),
  provider: text('provider').notNull(),
  url: text('url').notNull(),
  label: text('label').notNull(),
  frontedResourceJson: text('fronted_resource_json').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
}, (table) => [
  index('publications_run_created_idx').on(table.runId, table.createdAt)
]);

export const pullRequests = sqliteTable('pull_requests', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull().references(() => runs.id),
  ownerJson: text('owner_json').notNull(),
  tenant: text('tenant').notNull(),
  provider: text('provider').notNull(),
  number: integer('number').notNull(),
  url: text('url').notNull(),
  state: text('state').notNull(),
  branch: text('branch').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
}, (table) => [
  uniqueIndex('pull_requests_one_per_run').on(table.runId)
]);

export const runSteps = sqliteTable('run_steps', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull().references(() => runs.id),
  phase: text('phase'),
  step: text('step').notNull(),
  role: text('role').notNull(),
  startedAt: text('started_at').notNull(),
  endedAt: text('ended_at'),
  durationMs: integer('duration_ms'),
  occurrenceJson: text('occurrence_json').notNull(),
  checkpointResultJson: text('checkpoint_result_json')
}, (table) => [
  index('run_steps_run_started_idx').on(table.runId, table.startedAt)
]);

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull().references(() => runs.id),
  phase: text('phase'),
  step: text('step').notNull(),
  role: text('role').notNull(),
  round: integer('round').notNull(),
  modelJson: text('model_json').notNull(),
  inferenceSettingsJson: text('inference_settings_json').notNull(),
  startedAt: text('started_at').notNull(),
  endedAt: text('ended_at'),
  durationMs: integer('duration_ms'),
  tokensJson: text('tokens_json').notNull(),
  usageAvailable: integer('usage_available', { mode: 'boolean' }).notNull(),
  assistantTurnCount: integer('assistant_turn_count').notNull(),
  toolCallCount: integer('tool_call_count').notNull(),
  outcome: text('outcome').notNull(),
  costJson: text('cost_json').notNull()
}, (table) => [
  index('sessions_run_started_idx').on(table.runId, table.startedAt),
  index('sessions_run_step_role_idx').on(table.runId, table.step, table.role)
]);

export const runWorkspaceMetadata = sqliteTable('run_workspace_metadata', {
  runId: text('run_id').primaryKey().references(() => runs.id),
  workspaceHandle: text('workspace_handle').notNull(),
  workspaceRepoRoot: text('workspace_repo_root').notNull(),
  createdAt: text('created_at').notNull()
});

export const testResults = sqliteTable('test_results', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull().references(() => runs.id),
  testerJson: text('tester_json').notNull(),
  outcome: text('outcome').notNull(),
  evidenceJson: text('evidence_json'),
  feedbackRefsJson: text('feedback_refs_json').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
}, (table) => [
  index('test_results_run_created_idx').on(table.runId, table.createdAt)
]);
