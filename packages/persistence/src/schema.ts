import { sql } from 'drizzle-orm';
import type { InferenceSettings, ModelIdentity } from '@autocatalyst/api-contract';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

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
  index('configuration_records_tenant_kind_idx').on(table.tenant, table.kind),
  uniqueIndex('configuration_model_rate_revision_idx').on(
    table.tenant, sql`json_extract(${table.settingsJson}, '$.provider')`, sql`json_extract(${table.settingsJson}, '$.model')`,
    sql`json_extract(${table.settingsJson}, '$.effectiveAt')`, sql`json_extract(${table.settingsJson}, '$.revision')`
  ).where(sql`${table.kind} = 'model_rate_table'`)
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
  failureReason: text('failure_reason'),
  archivedAt: text('archived_at'),
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
  autocatalystHeadSha: text('autocatalyst_head_sha'),
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

export const testingGuides = sqliteTable('testing_guides', {
  id: text('id').primaryKey().notNull(),
  runId: text('run_id').notNull().references(() => runs.id),
  tenant: text('tenant').notNull(),
  revision: integer('revision').notNull(),
  runStepId: text('run_step_id').notNull().references(() => runSteps.id),
  instructions: text('instructions').notNull(),
  itemsJson: text('items_json').notNull(),
  createdAt: text('created_at').notNull()
}, table => [
  check('testing_guides_revision_check', sql`typeof(${table.revision}) = 'integer' and ${table.revision} >= 1`),
  uniqueIndex('testing_guides_run_revision_idx').on(table.runId, table.revision),
  uniqueIndex('testing_guides_run_step_idx').on(table.runStepId)
]);

export const prCiRepairHeads = sqliteTable('pr_ci_repair_heads', {
  pullRequestId: text('pull_request_id').notNull().references(() => pullRequests.id),
  headSha: text('head_sha').notNull(),
  gateStepId: text('gate_step_id').notNull().references(() => runSteps.id),
  repairStepId: text('repair_step_id').unique().references(() => runSteps.id),
  currentStepId: text('current_step_id').references(() => runSteps.id),
  outcomeStepId: text('outcome_step_id').references(() => runSteps.id),
  ordinal: integer('ordinal'),
  limitAtDecision: integer('limit_at_decision').notNull(),
  admittedCount: integer('admitted_count').notNull(),
  state: text('state', { enum: ['external', 'exhausted', 'queued', 'running', 'awaiting_human', 'publishing', 'pushed', 'stopped', 'superseded'] }).notNull(),
  baseRef: text('base_ref').notNull(),
  failureDetailsJson: text('failure_details_json').notNull(),
  ownerEpoch: text('owner_epoch'),
  publishHeadSha: text('publish_head_sha'),
  candidateSha: text('candidate_sha'),
  pushReceiptJson: text('push_receipt_json'),
  refreshCount: integer('refresh_count').notNull().default(0),
  stopCode: text('stop_code'),
  workspaceHold: integer('workspace_hold', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
}, (table) => [
  primaryKey({ columns: [table.pullRequestId, table.headSha] }),
  uniqueIndex('pr_ci_repair_heads_ordinal').on(table.pullRequestId, table.ordinal),
  uniqueIndex('pr_ci_repair_heads_one_active').on(table.pullRequestId)
    .where(sql`${table.state} IN ('queued','running','awaiting_human','publishing')`)
]);

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull().references(() => runs.id),
  sequence: integer('sequence').notNull(),
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
  costJson: text('cost_json').notNull(),
  usageJson: text('usage_json')
}, (table) => [
  index('sessions_run_started_idx').on(table.runId, table.startedAt),
  index('sessions_run_step_role_idx').on(table.runId, table.step, table.role),
  uniqueIndex('sessions_run_sequence_idx').on(table.runId, table.sequence)
]);

export const runWorkspaceMetadata = sqliteTable('run_workspace_metadata', {
  runId: text('run_id').primaryKey().references(() => runs.id),
  workspaceHandle: text('workspace_handle').notNull(),
  workspaceRepoRoot: text('workspace_repo_root').notNull(),
  provisionedBaseRef: text('provisioned_base_ref'),
  generation: text('generation').notNull().default(''),
  enrollmentProof: text('enrollment_proof'),
  createdAt: text('created_at').notNull()
});

export const agentConversationSlots = sqliteTable('agent_conversation_slots', {
  tenant: text('tenant').notNull(),
  runId: text('run_id').notNull().references(() => runs.id, { onDelete: 'cascade' }),
  step: text('step', { enum: ['spec.author', 'implementation.build'] }).notNull(),
  role: text('role', { enum: ['implementer', 'reviewer'] }).notNull(),
  workspaceGeneration: text('workspace_generation').notNull(),
  storageScope: text('storage_scope'),
  compatibilityDigest: text('compatibility_digest'),
  scopeDigest: text('scope_digest'),
  prIdentity: text('pr_identity'),
  nativeHandle: text('native_handle'),
  adapterMetadata: text('adapter_metadata', { mode: 'json' }).$type<{ version: 1 }>(),
  completedAttemptId: text('completed_attempt_id'),
  claimingAttemptId: text('claiming_attempt_id'),
  latestAttemptId: text('latest_attempt_id'),
  state: text('state', { enum: ['ready', 'in_flight', 'retired'] }).notNull(),
  version: integer('version').notNull()
}, t => [
  primaryKey({ columns: [t.tenant, t.runId, t.step, t.role] }),
  check('agent_conversation_step_check', sql`${t.step} IN ('spec.author', 'implementation.build')`),
  check('agent_conversation_role_check', sql`${t.role} IN ('implementer', 'reviewer')`),
  check('agent_conversation_state_check', sql`${t.state} IN ('ready', 'in_flight', 'retired')`),
  check('agent_conversation_version_check', sql`${t.version} > 0`),
  check('agent_conversation_ready_check', sql`${t.state} <> 'ready' OR (${t.nativeHandle} IS NOT NULL AND ${t.completedAttemptId} IS NOT NULL AND ${t.storageScope} IS NOT NULL AND ${t.compatibilityDigest} IS NOT NULL AND ${t.scopeDigest} IS NOT NULL)`),
  check('agent_conversation_in_flight_check', sql`${t.state} <> 'in_flight' OR ${t.claimingAttemptId} IS NOT NULL`)
]);

export const reviewedDispatchAttempts = sqliteTable('reviewed_dispatch_attempts', {
  order: integer('dispatch_order').primaryKey({ autoIncrement: true }),
  id: text('id').notNull().unique(),
  tenant: text('tenant').notNull(),
  runId: text('run_id').notNull().references(() => runs.id, { onDelete: 'cascade' }),
  occurrenceId: text('occurrence_id').notNull(),
  step: text('step', { enum: ['spec.author', 'implementation.build'] }).notNull(),
  role: text('role', { enum: ['implementer', 'reviewer'] }).notNull(),
  round: integer('round').notNull(),
  launch: text('launch_json', { mode: 'json' }).$type<{ model: ModelIdentity; inferenceSettings: InferenceSettings; startedAt: string }>(),
  decision: text('decision', { enum: ['fresh', 'resume', 'fallback', 'retention_disallowed'] }).notNull()
}, t => [
  index('reviewed_dispatch_latest_idx').on(t.tenant, t.runId, t.step, t.role, t.order),
  check('reviewed_dispatch_step_check', sql`${t.step} IN ('spec.author', 'implementation.build')`),
  check('reviewed_dispatch_role_check', sql`${t.role} IN ('implementer', 'reviewer')`),
  check('reviewed_dispatch_round_check', sql`${t.round} > 0`),
  check('reviewed_dispatch_decision_check', sql`${t.decision} IN ('fresh', 'resume', 'fallback', 'retention_disallowed')`)
]);

export const testResults = sqliteTable('test_results', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull().references(() => runs.id),
  guideRevision: integer('guide_revision'),
  gateStepId: text('gate_step_id').references(() => runSteps.id),
  state: text('state', { enum: ['working', 'final'] }).notNull().default('final'),
  itemsJson: text('items_json').notNull().default('[]'),
  testerJson: text('tester_json').notNull(),
  outcome: text('outcome').notNull(),
  evidenceJson: text('evidence_json'),
  feedbackRefsJson: text('feedback_refs_json').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
}, (table) => [
  index('test_results_run_created_idx').on(table.runId, table.createdAt),
  uniqueIndex('test_results_working_run_idx').on(table.runId).where(sql`${table.state} = 'working'`),
  uniqueIndex('test_results_gate_step_idx').on(table.gateStepId).where(sql`${table.gateStepId} IS NOT NULL`),
  check('test_results_state_check', sql`${table.state} IN ('working', 'final')`),
  check('test_results_guide_revision_check', sql`${table.guideRevision} IS NULL OR (typeof(${table.guideRevision}) = 'integer' AND ${table.guideRevision} >= 1)`),
  check('test_results_gate_binding_check', sql`(${table.guideRevision} IS NULL) = (${table.gateStepId} IS NULL)
    AND (${table.state} = 'final' OR ${table.gateStepId} IS NOT NULL)`)
]);
