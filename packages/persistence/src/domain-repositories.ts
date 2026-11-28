import { rowToRecord } from './configuration-record-repository.js';
import { randomUUID } from 'node:crypto';

import { and, asc, count, desc, eq, gt, inArray, isNotNull, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';

import type {
  Artifact,
  ArtifactCachedStatus,
  ArtifactKind,
  Conversation,
  CreateArtifactInput,
  CreateConversationInput,
  CreateFeedbackInput,
  CreateMessageInput,
  CreateProjectInput,
  CreatePublicationInput,
  CreatePullRequestInput,
  CreateRunInput,
  CreateRunStepInput,
  CreateSessionInput,
  CreateTestResultInput,
  CreateTopicInput,
  Feedback,
  FeedbackStatus,
  JsonValue,
  Message,
  Project,
  Publication,
  PullRequest,
  Run,
  RunStatus,
  RunStep,
  RunWaitingOn,
  StoredSession,
  ModelRateRecord,
  TestResult,
  Topic,
  TrackedIssue
} from '@autocatalyst/api-contract';
import {
  artifactSchema,
  channelReferenceSchema,
  convergenceCheckpointSchema,
  conversationSchema,
  costSchema,
  createArtifactInputSchema,
  createConversationInputSchema,
  createFeedbackInputSchema,
  createMessageInputSchema,
  createProjectInputSchema,
  createPublicationInputSchema,
  createPullRequestInputSchema,
  createRunInputSchema,
  createRunStepInputSchema,
  createSessionInputSchema,
  createTestResultInputSchema,
  createTopicInputSchema,
  credentialReferenceSchema,
  feedbackAnchorSchema,
  feedbackSchema,
  feedbackThreadSchema,
  frontedResourceSchema,
  inferenceSettingsSchema,
  jsonValueSchema,
  messageSchema,
  modelIdentitySchema,
  nonModelPrincipalSchema,
  principalSchema,
  projectSchema,
  publicationSchema,
  pullRequestSchema,
  runSchema,
  runStepSchema,
  storedSessionSchema,
  sessionUsageSchema,
  testResultEvidenceSchema,
  testResultSchema,
  testingGuideSchema,
  testingGuideResultSchema,
  tokenBreakdownSchema,
  topicSchema,
  trackedIssueSchema
} from '@autocatalyst/api-contract';
import type {
  ArtifactRepository,
  ConversationIngressRepository,
  ConversationRepository,
  CreateConversationTopicMessageAndRunInput,
  CreateConversationTopicMessageAndRunResult,
  DomainRepositories,
  FeedbackAnchorOffsetsPersistenceInput,
  SpecReviewAnchorPersistenceInput,
  FeedbackRepository,
  FeedbackStatusTransitionPersistenceInput,
  FeedbackThreadAppendPersistenceInput,
  LifecycleRunStepInput,
  ListOpenPullRequestsInput,
  ListRunsByTenantOptions,
  ListRunsByTenantResult,
  MessageRepository,
  ProjectRepository,
  PublicationRepository,
  PullRequestRepository,
  RecordRunLifecycleStartInput,
  RecordRunLifecycleStartResult,
  RecordRunStepTransitionInput,
  RecordRunStepTransitionResult,
  RecoverFailedRunInput,
  RecoverFailedRunResult,
  RunRepository,
  RunWorkspaceMetadata,
  RunWorkspaceMetadataRepository,
  UpsertRunWorkspaceMetadataInput,
  RunStepRepository,
  SessionRepository,
  TestResultRepository,
  StoredTestingGuide,
  TestingGuideRepository,
  TopicRepository,
  UpdateProjectInput,
  UpdatePullRequestStateInput,
  UpdateRunStepCheckpointInput
} from '@autocatalyst/core';
import { RunTransitionConflictError, ArchivedRunRecoveryError, FeedbackConcurrentModificationError, PullRequestStateConflictError, runStepDefinitions } from '@autocatalyst/core';

import { ActiveRunConflictPersistenceError, isActiveRunConstraintViolation } from './active-run-conflict.js';
import {
  nullableJsonForRow,
  parseJsonValue,
  parseNullableJsonValue,
  stringifyJsonValue,
  validateEntity
} from './domain-row-mappers.js';
import {
  artifacts,
  conversations,
  feedback,
  messages,
  projects,
  publications,
  pullRequests,
  runSteps,
  runWorkspaceMetadata,
  runs,
  sessions,
  configurationRecords,
  testResults,
  testingGuides,
  topics
} from './schema.js';
import type { SqliteDatabase } from './sqlite.js';
import { asInternalSqliteDatabase } from './sqlite.js';

// Inline schemas shared with persistence layer only

const hostRepositorySchema = z.object({
  provider: z.string().min(1),
  owner: z.string().min(1),
  name: z.string().min(1),
  url: z.string().url().optional()
}).strict();

const projectSettingReferenceSchema = z.object({
  provider: z.string().min(1),
  projectKey: z.string().min(1).optional(),
  url: z.string().url().optional(),
  credentialRef: credentialReferenceSchema.optional()
}).strict();

const credentialReferenceArraySchema = z.array(credentialReferenceSchema);
const publicationRefsSchema = z.array(z.string().min(1));
const feedbackRefsSchema = z.array(z.string().min(1));

// Legacy-tolerant reader for persisted trackedIssue/linkedIssue JSON from before body/labels were added.
const persistedTrackedIssueSchema = z.preprocess(
  (value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
    const record = value as Record<string, unknown>;
    return {
      ...record,
      body: record['body'] === undefined ? '' : record['body'],
      labels: record['labels'] === undefined ? [] : record['labels']
    };
  },
  trackedIssueSchema
) as z.ZodType<TrackedIssue, z.ZodTypeDef, unknown>;

const occurrenceSchema = z.object({
  index: z.number().int().min(0),
  attempt: z.number().int().min(1),
  key: z.string().min(1).optional()
}).strict();

function nowIso(): string {
  return new Date().toISOString();
}

function requireParent(rows: unknown[], parentId: string, parentName: string): void {
  if (rows.length === 0) {
    throw new Error(`${parentName} '${parentId}' does not exist.`);
  }
}

// ---------------------------------------------------------------------------
// Shared transaction helper
// ---------------------------------------------------------------------------

type DrizzleDb = ReturnType<typeof asInternalSqliteDatabase>['drizzle'];
type DrizzleTx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

export function buildRunStepInsideTransaction(
  tx: DrizzleTx,
  runId: string,
  input: LifecycleRunStepInput,
  checkpointResult: JsonValue = null
): RunStep {
  const existingForRun: number = tx.select({ value: count() }).from(runSteps).where(eq(runSteps.runId, runId)).all()[0]?.value ?? 0;
  const existingForStep: number = tx.select({ value: count() }).from(runSteps).where(and(eq(runSteps.runId, runId), eq(runSteps.step, input.step))).all()[0]?.value ?? 0;
  const occurrence = { index: existingForRun, attempt: existingForStep + 1 };
  const entity = validateEntity(runStepSchema, {
    id: `step_${randomUUID()}`,
    runId,
    phase: input.phase,
    step: input.step,
    role: input.role,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    durationMs: input.durationMs,
    occurrence,
    checkpointResult
  });
  tx.insert(runSteps).values({
    id: entity.id,
    runId: entity.runId,
    phase: entity.phase,
    step: entity.step,
    role: entity.role,
    startedAt: entity.startedAt,
    endedAt: entity.endedAt,
    durationMs: entity.durationMs,
    occurrenceJson: stringifyJsonValue(occurrenceSchema, entity.occurrence),
    checkpointResultJson: nullableJsonForRow(jsonValueSchema, entity.checkpointResult)
  }).run();
  return entity;
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export class DrizzleProjectRepository implements ProjectRepository {
  readonly #database;

  constructor(database: SqliteDatabase) {
    this.#database = asInternalSqliteDatabase(database);
  }

  async create(input: CreateProjectInput): Promise<Project> {
    const parsed = createProjectInputSchema.parse(input);
    const now = nowIso();
    const project: Project = validateEntity(projectSchema, {
      id: `proj_${randomUUID()}`,
      owner: parsed.owner,
      tenant: parsed.tenant,
      displayName: parsed.displayName,
      repoUrl: parsed.repoUrl,
      hostRepository: parsed.hostRepository,
      workspaceRootOverride: parsed.workspaceRootOverride,
      issueTrackerSetting: parsed.issueTrackerSetting,
      codeHostSetting: parsed.codeHostSetting,
      credentialRefs: parsed.credentialRefs,
      createdAt: now,
      updatedAt: now
    });

    this.#database.drizzle.insert(projects).values({
      id: project.id,
      ownerJson: stringifyJsonValue(nonModelPrincipalSchema, project.owner),
      tenant: project.tenant,
      displayName: project.displayName,
      repoUrl: project.repoUrl,
      hostRepositoryJson: stringifyJsonValue(hostRepositorySchema, project.hostRepository),
      workspaceRootOverride: project.workspaceRootOverride,
      issueTrackerSettingJson: nullableJsonForRow(projectSettingReferenceSchema, project.issueTrackerSetting),
      codeHostSettingJson: nullableJsonForRow(projectSettingReferenceSchema, project.codeHostSetting),
      credentialRefsJson: stringifyJsonValue(credentialReferenceArraySchema, project.credentialRefs),
      createdAt: project.createdAt,
      updatedAt: project.updatedAt
    }).run();

    return project;
  }

  findById(id: string): Promise<Project | null>;
  findById(tenant: string, id: string): Promise<Project | null>;
  async findById(tenantOrId: string, maybeId?: string): Promise<Project | null> {
    const where = maybeId === undefined
      ? eq(projects.id, tenantOrId)
      : and(eq(projects.tenant, tenantOrId), eq(projects.id, maybeId));
    const rows = this.#database.drizzle.select().from(projects).where(where).limit(1).all();
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    return this.#rowToProject(row);
  }

  async list(tenant: string): Promise<readonly Project[]> {
    const rows = this.#database.drizzle
      .select()
      .from(projects)
      .where(eq(projects.tenant, tenant))
      .orderBy(asc(projects.createdAt), asc(projects.id))
      .all();
    return rows.map((row) => this.#rowToProject(row));
  }

  async update(tenant: string, id: string, input: UpdateProjectInput): Promise<Project | null> {
    const existing = this.#database.drizzle
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.tenant, tenant), eq(projects.id, id)))
      .limit(1)
      .all()[0];
    if (existing === undefined) {
      return null;
    }

    const changes: Partial<typeof projects.$inferInsert> = { updatedAt: nowIso() };
    if (input.displayName !== undefined) {
      changes.displayName = input.displayName;
    }
    if (input.issueTrackerSetting !== undefined) {
      changes.issueTrackerSettingJson = nullableJsonForRow(projectSettingReferenceSchema, input.issueTrackerSetting);
    }
    if (input.codeHostSetting !== undefined) {
      changes.codeHostSettingJson = nullableJsonForRow(projectSettingReferenceSchema, input.codeHostSetting);
    }
    if (input.credentialRefs !== undefined) {
      changes.credentialRefsJson = stringifyJsonValue(credentialReferenceArraySchema, input.credentialRefs);
    }

    this.#database.drizzle
      .update(projects)
      .set(changes)
      .where(and(eq(projects.tenant, tenant), eq(projects.id, id)))
      .run();

    const updated = this.#database.drizzle
      .select()
      .from(projects)
      .where(and(eq(projects.tenant, tenant), eq(projects.id, id)))
      .limit(1)
      .all()[0];
    return updated === undefined ? null : this.#rowToProject(updated);
  }

  #rowToProject(row: typeof projects.$inferSelect): Project {
    return validateEntity(projectSchema, {
      id: row.id,
      owner: parseJsonValue(nonModelPrincipalSchema, row.ownerJson),
      tenant: row.tenant,
      displayName: row.displayName,
      repoUrl: row.repoUrl,
      hostRepository: parseJsonValue(hostRepositorySchema, row.hostRepositoryJson),
      workspaceRootOverride: row.workspaceRootOverride,
      issueTrackerSetting: parseNullableJsonValue(projectSettingReferenceSchema, row.issueTrackerSettingJson),
      codeHostSetting: parseNullableJsonValue(projectSettingReferenceSchema, row.codeHostSettingJson),
      credentialRefs: parseJsonValue(credentialReferenceArraySchema, row.credentialRefsJson),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    });
  }
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export class DrizzleConversationRepository implements ConversationRepository {
  readonly #database;

  constructor(database: SqliteDatabase) {
    this.#database = asInternalSqliteDatabase(database);
  }

  async create(input: CreateConversationInput): Promise<Conversation> {
    const parsed = createConversationInputSchema.parse(input);
    const parentRows = this.#database.drizzle.select({ id: projects.id }).from(projects).where(eq(projects.id, parsed.projectId)).limit(1).all();
    requireParent(parentRows, parsed.projectId, 'Project');
    const now = nowIso();
    const entity: Conversation = validateEntity(conversationSchema, {
      id: `conv_${randomUUID()}`,
      projectId: parsed.projectId,
      owner: parsed.owner,
      tenant: parsed.tenant,
      identity: parsed.identity,
      ...(parsed.channel === undefined ? {} : { channel: parsed.channel }),
      activeTopicId: parsed.activeTopicId,
      createdAt: now,
      updatedAt: now
    });

    this.#database.drizzle.insert(conversations).values({
      id: entity.id,
      projectId: entity.projectId,
      ownerJson: stringifyJsonValue(nonModelPrincipalSchema, entity.owner),
      tenant: entity.tenant,
      identity: entity.identity,
      channelJson: nullableJsonForRow(channelReferenceSchema, entity.channel),
      activeTopicId: entity.activeTopicId,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt
    }).run();

    return entity;
  }

  async findById(id: string): Promise<Conversation | null> {
    const rows = this.#database.drizzle.select().from(conversations).where(eq(conversations.id, id)).limit(1).all();
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    return this.#rowToConversation(row);
  }

  async setActiveTopic(conversationId: string, topicId: string): Promise<Conversation> {
    if (!topicId || topicId.trim().length === 0) {
      throw new Error('topicId is required.');
    }
    const topicRows = this.#database.drizzle.select().from(topics).where(eq(topics.id, topicId)).limit(1).all();
    if (topicRows[0] === undefined) {
      throw new Error(`Topic ${topicId} does not exist.`);
    }
    if (topicRows[0].conversationId !== conversationId) {
      throw new Error(`Topic ${topicId} does not belong to conversation ${conversationId}.`);
    }
    const updatedAt = nowIso();
    this.#database.drizzle.update(conversations).set({ activeTopicId: topicId, updatedAt }).where(eq(conversations.id, conversationId)).run();
    const updated = this.#database.drizzle.select().from(conversations).where(eq(conversations.id, conversationId)).limit(1).all();
    if (updated[0] === undefined) {
      throw new Error(`Conversation ${conversationId} does not exist.`);
    }
    return this.#rowToConversation(updated[0]);
  }

  #rowToConversation(row: typeof conversations.$inferSelect): Conversation {
    const channel = parseNullableJsonValue(channelReferenceSchema, row.channelJson);
    return validateEntity(conversationSchema, {
      id: row.id,
      projectId: row.projectId,
      owner: parseJsonValue(nonModelPrincipalSchema, row.ownerJson),
      tenant: row.tenant,
      identity: row.identity,
      ...(channel === null ? {} : { channel }),
      activeTopicId: row.activeTopicId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    });
  }
}

// ---------------------------------------------------------------------------
// Topics
// ---------------------------------------------------------------------------

export class DrizzleTopicRepository implements TopicRepository {
  readonly #database;

  constructor(database: SqliteDatabase) {
    this.#database = asInternalSqliteDatabase(database);
  }

  async create(input: CreateTopicInput): Promise<Topic> {
    const parsed = createTopicInputSchema.parse(input);
    const parentRows = this.#database.drizzle.select({ id: conversations.id }).from(conversations).where(eq(conversations.id, parsed.conversationId)).limit(1).all();
    requireParent(parentRows, parsed.conversationId, 'Conversation');
    const now = nowIso();
    const entity: Topic = validateEntity(topicSchema, {
      id: `topic_${randomUUID()}`,
      conversationId: parsed.conversationId,
      owner: parsed.owner,
      tenant: parsed.tenant,
      title: parsed.title,
      kind: parsed.kind,
      createdAt: now,
      updatedAt: now
    });

    this.#database.drizzle.insert(topics).values({
      id: entity.id,
      conversationId: entity.conversationId,
      ownerJson: stringifyJsonValue(nonModelPrincipalSchema, entity.owner),
      tenant: entity.tenant,
      title: entity.title,
      kind: entity.kind,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt
    }).run();

    return entity;
  }

  async findById(id: string): Promise<Topic | null> {
    const rows = this.#database.drizzle.select().from(topics).where(eq(topics.id, id)).limit(1).all();
    const row = rows[0];
    return row === undefined ? null : this.#rowToTopic(row);
  }

  async updateTitle(tenant: string, id: string, title: string): Promise<Topic | null> {
    const [row] = this.#database.drizzle.update(topics)
      .set({ title, updatedAt: nowIso() })
      .where(and(eq(topics.id, id), eq(topics.tenant, tenant)))
      .returning().all();
    return row === undefined ? null : this.#rowToTopic(row);
  }

  async listByConversation(conversationId: string): Promise<readonly Topic[]> {
    const rows = this.#database.drizzle
      .select()
      .from(topics)
      .where(eq(topics.conversationId, conversationId))
      .orderBy(asc(topics.createdAt), asc(topics.id))
      .all();
    return rows.map((row) => this.#rowToTopic(row));
  }

  #rowToTopic(row: typeof topics.$inferSelect): Topic {
    return validateEntity(topicSchema, {
      id: row.id,
      conversationId: row.conversationId,
      owner: parseJsonValue(nonModelPrincipalSchema, row.ownerJson),
      tenant: row.tenant,
      title: row.title,
      kind: row.kind,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    });
  }
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export class DrizzleMessageRepository implements MessageRepository {
  readonly #database;

  constructor(database: SqliteDatabase) {
    this.#database = asInternalSqliteDatabase(database);
  }

  async create(input: CreateMessageInput): Promise<Message> {
    const parsed = createMessageInputSchema.parse(input);
    const parentRows = this.#database.drizzle.select({ id: topics.id }).from(topics).where(eq(topics.id, parsed.topicId)).limit(1).all();
    requireParent(parentRows, parsed.topicId, 'Topic');
    const now = nowIso();
    const entity: Message = validateEntity(messageSchema, {
      id: `msg_${randomUUID()}`,
      topicId: parsed.topicId,
      owner: parsed.owner,
      tenant: parsed.tenant,
      author: parsed.author,
      direction: parsed.direction,
      body: parsed.body,
      ...(parsed.intent === undefined ? {} : { intent: parsed.intent }),
      createdAt: now
    });

    this.#database.drizzle.insert(messages).values({
      id: entity.id,
      topicId: entity.topicId,
      ownerJson: stringifyJsonValue(nonModelPrincipalSchema, entity.owner),
      tenant: entity.tenant,
      authorJson: stringifyJsonValue(principalSchema, entity.author),
      direction: entity.direction,
      body: entity.body,
      intent: entity.intent ?? null,
      createdAt: entity.createdAt
    }).run();

    return entity;
  }

  async findById(id: string): Promise<Message | null> {
    const rows = this.#database.drizzle.select().from(messages).where(eq(messages.id, id)).limit(1).all();
    const row = rows[0];
    return row === undefined ? null : this.#rowToMessage(row);
  }

  async listByTopic(topicId: string): Promise<readonly Message[]> {
    const rows = this.#database.drizzle
      .select()
      .from(messages)
      .where(eq(messages.topicId, topicId))
      .orderBy(asc(messages.createdAt), asc(messages.id))
      .all();
    return rows.map((row) => this.#rowToMessage(row));
  }

  #rowToMessage(row: typeof messages.$inferSelect): Message {
    return validateEntity(messageSchema, {
      id: row.id,
      topicId: row.topicId,
      owner: parseJsonValue(nonModelPrincipalSchema, row.ownerJson),
      tenant: row.tenant,
      author: parseJsonValue(principalSchema, row.authorJson),
      direction: row.direction,
      body: row.body,
      ...(row.intent === null ? {} : { intent: row.intent }),
      createdAt: row.createdAt
    });
  }
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export const defaultRunListLimit = 100;

export function normalizeRunListLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return defaultRunListLimit;
  }
  if (!Number.isInteger(limit) || !Number.isFinite(limit) || limit <= 0) {
    throw new RangeError('Run list limit must be a positive integer.');
  }
  return Math.min(limit, defaultRunListLimit);
}

// Status is derived, not stored, so the status filter is translated into predicates over the
// stored `terminal`/`currentStep` columns that exactly mirror the read mapper's derivation.
function runStatusPredicate(status: RunStatus): SQL {
  if (status === 'in_progress') {
    return eq(runs.terminal, false);
  }
  return and(eq(runs.terminal, true), eq(runs.currentStep, status)) as SQL;
}

// waitingOn is also derived from the step catalog, so the waitingOn filter is translated into the
// set of current-step ids that map to the requested waiting classes. This keeps filtering in SQL
// (before page selection) instead of loading rows and filtering in memory.
function stepsForWaitingOn(values: readonly RunWaitingOn[]): string[] {
  const requested = new Set<RunWaitingOn>(values);
  return runStepDefinitions.filter((definition) => requested.has(definition.waitingOn)).map((definition) => definition.id);
}

export class DrizzleRunRepository implements RunRepository {
  readonly #database;

  constructor(database: SqliteDatabase) {
    this.#database = asInternalSqliteDatabase(database);
  }

  async create(input: CreateRunInput): Promise<Run> {
    const parsed = createRunInputSchema.parse(input);
    const parentRows = this.#database.drizzle.select({ id: topics.id }).from(topics).where(eq(topics.id, parsed.topicId)).limit(1).all();
    requireParent(parentRows, parsed.topicId, 'Topic');
    const now = nowIso();
    const entity: Run = validateEntity(runSchema, {
      id: `run_${randomUUID()}`,
      topicId: parsed.topicId,
      owner: parsed.owner,
      tenant: parsed.tenant,
      workKind: parsed.workKind,
      currentStep: parsed.currentStep,
      terminal: parsed.terminal,
      ...(parsed.trackedIssue === undefined ? {} : { trackedIssue: parsed.trackedIssue }),
      ...(parsed.testingGuideResult === undefined ? {} : { testingGuideResult: parsed.testingGuideResult }),
      createdAt: now,
      updatedAt: now
    });

    this.#database.drizzle.insert(runs).values({
      id: entity.id,
      topicId: entity.topicId,
      ownerJson: stringifyJsonValue(nonModelPrincipalSchema, entity.owner),
      tenant: entity.tenant,
      workKind: entity.workKind,
      currentStep: entity.currentStep,
      terminal: entity.terminal,
      trackedIssueJson: nullableJsonForRow(trackedIssueSchema, entity.trackedIssue),
      testingGuideResultJson: nullableJsonForRow(testingGuideResultSchema, entity.testingGuideResult),
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt
    }).run();

    return entity;
  }

  async findById(id: string): Promise<Run | null> {
    const rows = this.#database.drizzle.select().from(runs).where(eq(runs.id, id)).limit(1).all();
    const row = rows[0];
    return row === undefined ? null : this.#rowToRun(row);
  }

  async findActiveByTopic(topicId: string): Promise<Run | null> {
    const rows = this.#database.drizzle
      .select()
      .from(runs)
      .where(and(eq(runs.topicId, topicId), eq(runs.terminal, false)))
      .orderBy(asc(runs.createdAt), asc(runs.id))
      .limit(1)
      .all();
    const row = rows[0];
    return row === undefined ? null : this.#rowToRun(row);
  }

  async listByTopic(topicId: string): Promise<readonly Run[]> {
    const rows = this.#database.drizzle
      .select()
      .from(runs)
      .where(eq(runs.topicId, topicId))
      .orderBy(asc(runs.createdAt), asc(runs.id))
      .all();
    return rows.map((row) => this.#rowToRun(row));
  }

  async listByTenant(tenant: string, options: ListRunsByTenantOptions = {}): Promise<ListRunsByTenantResult> {
    const limit = normalizeRunListLimit(options.limit);
    const filters = options.filters;

    // Tenant scoping is mandatory and comes from the authenticated caller, never from query input.
    const conditions: SQL[] = [eq(runs.tenant, tenant)];
    if (filters?.archived === 'only') conditions.push(isNotNull(runs.archivedAt));
    else if (filters?.archived !== 'include') conditions.push(isNull(runs.archivedAt));

    if (filters?.workKind !== undefined && filters.workKind.length > 0) {
      conditions.push(inArray(runs.workKind, [...filters.workKind]));
    }
    if (filters?.projectId !== undefined && filters.projectId.length > 0) {
      // Project filtering uses the joined conversations.projectId. A project id the tenant does not
      // own is simply absent once the tenant predicate applies, so the page comes back empty.
      conditions.push(inArray(conversations.projectId, [...filters.projectId]));
    }
    if (filters?.status !== undefined && filters.status.length > 0) {
      const statusConditions = filters.status.map(runStatusPredicate);
      conditions.push(statusConditions.length === 1 ? statusConditions[0]! : (or(...statusConditions) as SQL));
    }
    if (filters?.waitingOn !== undefined && filters.waitingOn.length > 0) {
      const steps = stepsForWaitingOn(filters.waitingOn);
      // No catalog step maps to the requested waiting class → no row can match.
      conditions.push(steps.length > 0 ? inArray(runs.currentStep, steps) : sql`1 = 0`);
    }
    if (options.cursor !== undefined) {
      // Continue the createdAt DESC, id DESC ordering strictly after the cursor position.
      conditions.push(
        or(
          lt(runs.createdAt, options.cursor.createdAt),
          and(eq(runs.createdAt, options.cursor.createdAt), lt(runs.id, options.cursor.id))
        ) as SQL
      );
    }

    // Join run → topic → conversation once for the whole page so projectId resolution and project
    // filtering stay a constant number of queries (never one read per run).
    const rows = this.#database.drizzle
      .select({ run: runs, projectId: conversations.projectId, title: topics.title })
      .from(runs)
      .innerJoin(topics, and(eq(runs.topicId, topics.id), eq(runs.tenant, topics.tenant)))
      .innerJoin(conversations, and(eq(topics.conversationId, conversations.id), eq(topics.tenant, conversations.tenant)))
      .where(and(...conditions))
      .orderBy(desc(runs.createdAt), desc(runs.id))
      // Request one extra row so nextCursor is emitted only when a further match actually exists.
      .limit(limit + 1)
      .all();

    const page = rows.slice(0, limit);
    const mapped = page.map((row) => this.#rowToRun(row.run, row));
    if (rows.length > limit && page.length > 0) {
      const last = page[page.length - 1]!;
      return { runs: mapped, nextCursor: { createdAt: last.run.createdAt, id: last.run.id } };
    }
    return { runs: mapped };
  }

  async resolveProjectId(runId: string): Promise<string | null> {
    return (await this.resolveRunContext(runId))?.projectId ?? null;
  }

  async resolveRunContext(runId: string) {
    const row = this.#database.drizzle
      .select({ projectId: conversations.projectId, title: topics.title })
      .from(runs)
      .innerJoin(topics, and(eq(runs.topicId, topics.id), eq(runs.tenant, topics.tenant)))
      .innerJoin(conversations, and(eq(topics.conversationId, conversations.id), eq(topics.tenant, conversations.tenant)))
      .where(eq(runs.id, runId))
      .limit(1)
      .all()[0];
    return row ?? null;
  }

  async setArchived(runId: string, tenant: string, archivedAt: string | null): Promise<Run | null> {
    return this.#database.drizzle.transaction((tx) => {
      const scope = and(eq(runs.id, runId), eq(runs.tenant, tenant));
      const [updated] = tx.update(runs).set({ archivedAt, updatedAt: nowIso() })
        .where(and(scope, archivedAt === null
          ? isNotNull(runs.archivedAt)
          : and(eq(runs.terminal, true), inArray(runs.currentStep, ['done', 'failed', 'canceled']), isNull(runs.archivedAt))))
        .returning().all();
      const row = updated ?? tx.select().from(runs).where(scope).get();
      return row === undefined ? null : this.#rowToRun(row);
    }, { behavior: 'immediate' });
  }

  async listNonTerminal(): Promise<readonly Run[]> {
    const rows = this.#database.drizzle
      .select()
      .from(runs)
      .where(eq(runs.terminal, false))
      .orderBy(asc(runs.createdAt), asc(runs.id))
      .all();
    return rows.map((row) => this.#rowToRun(row));
  }

  #rowToRun(row: typeof runs.$inferSelect, context?: { projectId: string; title: string }): Run {
    const trackedIssue = parseNullableJsonValue(persistedTrackedIssueSchema, row.trackedIssueJson);
    const testingGuideResult = parseNullableJsonValue(testingGuideResultSchema, row.testingGuideResultJson);
    return validateEntity(runSchema, {
      id: row.id,
      topicId: row.topicId,
      owner: parseJsonValue(nonModelPrincipalSchema, row.ownerJson),
      tenant: row.tenant,
      workKind: row.workKind,
      currentStep: row.currentStep,
      terminal: row.terminal,
      ...(context === undefined ? {} : { projectId: context.projectId, title: context.title }),
      ...(row.archivedAt === null ? {} : { archivedAt: row.archivedAt }),
      ...(trackedIssue === null ? {} : { trackedIssue }),
      ...(testingGuideResult === null ? {} : { testingGuideResult }),
      ...(row.failureReason === null || row.failureReason === undefined ? {} : { failureReason: row.failureReason }),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    });
  }

  async recordRunLifecycleStart(input: RecordRunLifecycleStartInput): Promise<RecordRunLifecycleStartResult> {
    const parsedRun = createRunInputSchema.parse(input.run);
    return this.#database.drizzle.transaction((tx) => {
      const parentRows = tx.select({ id: topics.id }).from(topics).where(eq(topics.id, parsedRun.topicId)).limit(1).all();
      requireParent(parentRows, parsedRun.topicId, 'Topic');
      const now = nowIso();
      const run = validateEntity(runSchema, {
        id: `run_${randomUUID()}`,
        topicId: parsedRun.topicId,
        owner: parsedRun.owner,
        tenant: parsedRun.tenant,
        workKind: parsedRun.workKind,
        currentStep: parsedRun.currentStep,
        terminal: parsedRun.terminal,
        ...(parsedRun.trackedIssue === undefined ? {} : { trackedIssue: parsedRun.trackedIssue }),
        ...(parsedRun.testingGuideResult === undefined ? {} : { testingGuideResult: parsedRun.testingGuideResult }),
        createdAt: now,
        updatedAt: now
      });
      try {
        tx.insert(runs).values({
          id: run.id,
          topicId: run.topicId,
          ownerJson: stringifyJsonValue(nonModelPrincipalSchema, run.owner),
          tenant: run.tenant,
          workKind: run.workKind,
          currentStep: run.currentStep,
          terminal: run.terminal,
          trackedIssueJson: nullableJsonForRow(trackedIssueSchema, run.trackedIssue),
          testingGuideResultJson: nullableJsonForRow(testingGuideResultSchema, run.testingGuideResult),
          createdAt: run.createdAt,
          updatedAt: run.updatedAt
        }).run();
      } catch (error) {
        if (isActiveRunConstraintViolation(error)) {
          throw new ActiveRunConflictPersistenceError(parsedRun.topicId, null);
        }
        throw error;
      }
      const runStep = buildRunStepInsideTransaction(tx, run.id, input.runStep);
      return { run, runStep };
    });
  }

  async recordRunStepTransition(input: RecordRunStepTransitionInput): Promise<RecordRunStepTransitionResult> {
    return this.#database.drizzle.transaction((tx) => {
      const existing = tx.select().from(runs).where(eq(runs.id, input.runId)).get();
      if (existing === undefined) throw new RunTransitionConflictError('missing_run');
      if (existing.terminal) throw new RunTransitionConflictError('terminal_run');
      if (existing.currentStep !== input.expectedStep) throw new RunTransitionConflictError('source_step_mismatch');

      const source = tx.select().from(runSteps)
        .where(and(eq(runSteps.runId, input.runId), eq(runSteps.step, input.expectedStep), isNull(runSteps.endedAt)))
        .orderBy(desc(runSteps.startedAt), desc(runSteps.id)).get();
      if (input.sourceRunStepId !== undefined && source?.id !== input.sourceRunStepId) {
        throw new RunTransitionConflictError('source_occurrence_mismatch');
      }

      const [updated] = tx.update(runs).set({
        currentStep: input.currentStep,
        terminal: input.terminal,
        failureReason: input.currentStep === 'failed' ? (input.failureReason ?? null) : null,
        updatedAt: nowIso()
      }).where(and(eq(runs.id, input.runId), eq(runs.terminal, false), eq(runs.currentStep, input.expectedStep)))
        .returning().all();
      if (updated === undefined) throw new RunTransitionConflictError('source_step_mismatch');
      const run = this.#rowToRun(updated);
      if (source !== undefined) {
        let checkpoint = input.checkpointResult;
        if (input.abandonInput) {
          const prior = parseNullableJsonValue(jsonValueSchema, source.checkpointResultJson);
          checkpoint = { ...(prior && typeof prior === 'object' && !Array.isArray(prior) ? prior : {}), abandonedBySetStep: true };
        }
        const transitionAt = input.runStep.startedAt;
        const duration = Date.parse(transitionAt) - Date.parse(source.startedAt);
        tx.update(runSteps).set({
          endedAt: transitionAt,
          durationMs: Number.isFinite(duration) && duration >= 0 ? duration : null,
          ...(checkpoint === undefined ? {} : { checkpointResultJson: stringifyJsonValue(jsonValueSchema, checkpoint) })
        }).where(eq(runSteps.id, source.id)).run();
      }
      if (input.publicationProvenance !== undefined) {
        const { pullRequestId, headSha } = input.publicationProvenance;
        if (input.currentStep !== 'pr.human_review' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(headSha)) {
          throw new Error('Invalid PR publication transition.');
        }
        const result = tx.update(pullRequests).set({ autocatalystHeadSha: headSha })
          .where(and(eq(pullRequests.id, pullRequestId), eq(pullRequests.runId, run.id),
            eq(pullRequests.tenant, run.tenant), eq(pullRequests.state, 'open'))).run();
        if (result.changes !== 1) throw new Error('PR publication binding changed.');
      }
      const runStep = buildRunStepInsideTransaction(tx, run.id, input.runStep, input.destinationCheckpointResult);
      return { run, runStep };
    }, { behavior: 'immediate' });
  }

  async recoverFailedRun(input: RecoverFailedRunInput): Promise<RecoverFailedRunResult> {
    return this.#database.drizzle.transaction((tx) => {
      const existingRow = tx.select({ topicId: runs.topicId, archivedAt: runs.archivedAt }).from(runs).where(eq(runs.id, input.runId)).limit(1).all()[0];
      const topicId = existingRow?.topicId ?? '';
      // Guarded update: only a failed terminal run may be reopened. The WHERE clause asserts
      // the run is currently terminal and at the `failed` step so a concurrent change cannot
      // reopen a non-failed run. Setting terminal=false re-arms the one-active-run-per-topic
      // partial unique index, which surfaces as an active-run conflict below.
      let updatedRows;
      try {
        updatedRows = tx.update(runs)
          .set({
            currentStep: input.reDispatchStep,
            terminal: false,
            failureReason: null,
            updatedAt: nowIso()
          })
          .where(and(eq(runs.id, input.runId), eq(runs.terminal, true), eq(runs.currentStep, 'failed'), isNull(runs.archivedAt)))
          .returning()
          .all();
      } catch (error) {
        if (isActiveRunConstraintViolation(error)) {
          throw new ActiveRunConflictPersistenceError(topicId, null);
        }
        throw error;
      }
      if (updatedRows[0] === undefined) {
        if (existingRow?.archivedAt != null) throw new ArchivedRunRecoveryError();
        throw new RunTransitionConflictError('terminal_run');
      }
      const run = this.#rowToRun(updatedRows[0]);
      // Create a new open RunStep for the re-dispatch step. Earlier rows, including the
      // terminal `failed` row, are left untouched so run history stays auditable.
      const runStep = buildRunStepInsideTransaction(tx, run.id, input.runStep, input.destinationCheckpointResult);
      return { run, runStep };
    }, { behavior: 'immediate' });
  }

  async findLatestOpenRunStep(input: { runId: string; step: string }): Promise<RunStep | null> {
    const rows = this.#database.drizzle
      .select()
      .from(runSteps)
      .where(and(eq(runSteps.runId, input.runId), eq(runSteps.step, input.step), isNull(runSteps.endedAt)))
      .orderBy(desc(runSteps.startedAt), desc(runSteps.id))
      .limit(1)
      .all();
    const row = rows[0];
    return row === undefined ? null : rowToRunStepEntity(row);
  }
}

function rowToRunStepEntity(row: typeof runSteps.$inferSelect): RunStep {
  return validateEntity(runStepSchema, {
    id: row.id,
    runId: row.runId,
    phase: row.phase,
    step: row.step,
    role: row.role,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    durationMs: row.durationMs,
    occurrence: parseJsonValue(occurrenceSchema, row.occurrenceJson),
    checkpointResult: row.checkpointResultJson === null ? null : parseJsonValue(jsonValueSchema, row.checkpointResultJson)
  });
}

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

export class DrizzleArtifactRepository implements ArtifactRepository {
  readonly #database;

  constructor(database: SqliteDatabase) {
    this.#database = asInternalSqliteDatabase(database);
  }

  async create(input: CreateArtifactInput): Promise<Artifact> {
    const parsed = createArtifactInputSchema.parse(input);
    const parentRows = this.#database.drizzle.select({ id: runs.id }).from(runs).where(eq(runs.id, parsed.runId)).limit(1).all();
    requireParent(parentRows, parsed.runId, 'Run');
    const now = nowIso();
    const entity: Artifact = validateEntity(artifactSchema, {
      id: `art_${randomUUID()}`,
      runId: parsed.runId,
      owner: parsed.owner,
      tenant: parsed.tenant,
      kind: parsed.kind,
      canonicalRecord: parsed.canonicalRecord,
      location: parsed.location,
      cachedStatus: parsed.cachedStatus,
      ...(parsed.linkedIssue === undefined ? {} : { linkedIssue: parsed.linkedIssue }),
      publicationRefs: parsed.publicationRefs,
      createdAt: now,
      updatedAt: now
    });

    this.#database.drizzle.insert(artifacts).values({
      id: entity.id,
      runId: entity.runId,
      ownerJson: stringifyJsonValue(nonModelPrincipalSchema, entity.owner),
      tenant: entity.tenant,
      kind: entity.kind,
      canonicalRecord: entity.canonicalRecord,
      location: entity.location,
      cachedStatus: entity.cachedStatus,
      linkedIssueJson: nullableJsonForRow(trackedIssueSchema, entity.linkedIssue),
      publicationRefsJson: stringifyJsonValue(publicationRefsSchema, entity.publicationRefs),
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt
    }).run();

    return entity;
  }

  async findById(id: string): Promise<Artifact | null> {
    const rows = this.#database.drizzle.select().from(artifacts).where(eq(artifacts.id, id)).limit(1).all();
    const row = rows[0];
    return row === undefined ? null : this.#rowToArtifact(row);
  }

  async listByRun(runId: string): Promise<readonly Artifact[]> {
    const rows = this.#database.drizzle
      .select()
      .from(artifacts)
      .where(eq(artifacts.runId, runId))
      .orderBy(asc(artifacts.createdAt), asc(artifacts.id))
      .all();
    return rows.map((row) => this.#rowToArtifact(row));
  }

  async findByRunAndKind(input: { readonly runId: string; readonly kind: ArtifactKind }): Promise<Artifact | null> {
    const row = this.#database.drizzle
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.runId, input.runId), eq(artifacts.kind, input.kind)))
      .orderBy(asc(artifacts.createdAt), asc(artifacts.id))
      .limit(1)
      .all()[0];
    return row === undefined ? null : this.#rowToArtifact(row);
  }

  async updateCachedStatus(input: { readonly artifactId: string; readonly cachedStatus: ArtifactCachedStatus; readonly updatedAt: string }): Promise<Artifact> {
    this.#database.drizzle
      .update(artifacts)
      .set({ cachedStatus: input.cachedStatus, updatedAt: input.updatedAt })
      .where(eq(artifacts.id, input.artifactId))
      .run();
    const row = this.#database.drizzle
      .select()
      .from(artifacts)
      .where(eq(artifacts.id, input.artifactId))
      .limit(1)
      .all()[0];
    if (row === undefined) {
      throw new Error(`Artifact '${input.artifactId}' does not exist.`);
    }
    return this.#rowToArtifact(row);
  }

  #rowToArtifact(row: typeof artifacts.$inferSelect): Artifact {
    const linkedIssue = parseNullableJsonValue(persistedTrackedIssueSchema, row.linkedIssueJson);
    return validateEntity(artifactSchema, {
      id: row.id,
      runId: row.runId,
      owner: parseJsonValue(nonModelPrincipalSchema, row.ownerJson),
      tenant: row.tenant,
      kind: row.kind,
      canonicalRecord: row.canonicalRecord,
      location: row.location,
      cachedStatus: row.cachedStatus,
      ...(linkedIssue === null ? {} : { linkedIssue }),
      publicationRefs: parseJsonValue(publicationRefsSchema, row.publicationRefsJson),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    });
  }
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

export class DrizzleFeedbackRepository implements FeedbackRepository {
  readonly #database;

  constructor(database: SqliteDatabase) {
    this.#database = asInternalSqliteDatabase(database);
  }

  async create(input: CreateFeedbackInput): Promise<Feedback> {
    return this.#create(input, `fb_${randomUUID()}`);
  }

  async createSpecReviewFinding(id: string, input: CreateFeedbackInput): Promise<Feedback> {
    if (!/^fb_spec_[a-f0-9]{64}$/u.test(id) || input.target !== 'artifact' || input.status !== 'open' || input.anchor !== undefined ||
        input.thread[0]?.author.kind !== 'model') throw new Error('Invalid spec review feedback.');
    this.#create(input, id, true);
    const row = await this.findById(id);
    if (row === null || row.runId !== input.runId || row.tenant !== input.tenant ||
        row.target !== 'artifact' || row.thread[0]?.author.kind !== 'model') {
      throw new Error('Spec review feedback identity mismatch.');
    }
    return row;
  }

  async bindSpecReviewAnchor(input: SpecReviewAnchorPersistenceInput): Promise<void> {
    this.#database.drizzle.transaction(tx => {
      const item = tx.select().from(feedback).where(eq(feedback.id, input.feedbackId)).get();
      const artifact = tx.select().from(artifacts).where(eq(artifacts.id, input.artifactId)).get();
      if (!/^fb_spec_[a-f0-9]{64}$/u.test(input.feedbackId) || item === undefined || artifact === undefined || item.runId !== input.runId ||
          item.tenant !== input.tenant || item.target !== 'artifact' ||
          artifact.runId !== input.runId || artifact.tenant !== input.tenant ||
          (artifact.kind !== 'feature_spec' && artifact.kind !== 'enhancement_spec') ||
          parseJsonValue(feedbackThreadSchema, item.threadJson)[0]?.author.kind !== 'model' ||
          (input.anchor !== null && input.anchor.artifactId !== input.artifactId)) {
        throw new Error('Invalid spec review anchor target.');
      }
      const next = nullableJsonForRow(feedbackAnchorSchema, input.anchor ?? undefined);
      if (item.anchorJson !== next) {
        tx.update(feedback).set({ anchorJson: next }).where(eq(feedback.id, item.id)).run();
      }
    });
  }

  #create(input: CreateFeedbackInput, id: string, retryable = false): Feedback {
    const parsed = createFeedbackInputSchema.parse(input);
    const parentRows = this.#database.drizzle.select({ id: runs.id }).from(runs).where(eq(runs.id, parsed.runId)).limit(1).all();
    requireParent(parentRows, parsed.runId, 'Run');
    const now = nowIso();
    const entity: Feedback = validateEntity(feedbackSchema, {
      id,
      runId: parsed.runId,
      owner: parsed.owner,
      tenant: parsed.tenant,
      target: parsed.target,
      status: parsed.status,
      title: parsed.title,
      body: parsed.body,
      ...(parsed.anchor === undefined ? {} : { anchor: parsed.anchor }),
      thread: parsed.thread,
      createdAt: now,
      updatedAt: now
    });

    const insert = this.#database.drizzle.insert(feedback).values({
      id: entity.id,
      runId: entity.runId,
      ownerJson: stringifyJsonValue(nonModelPrincipalSchema, entity.owner),
      tenant: entity.tenant,
      target: entity.target,
      status: entity.status,
      title: entity.title,
      body: entity.body,
      anchorJson: nullableJsonForRow(feedbackAnchorSchema, entity.anchor),
      threadJson: stringifyJsonValue(feedbackThreadSchema, entity.thread),
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt
    });
    if (retryable) insert.onConflictDoNothing({ target: feedback.id }).run();
    else insert.run();

    return entity;
  }

  async findById(id: string): Promise<Feedback | null> {
    const rows = this.#database.drizzle.select().from(feedback).where(eq(feedback.id, id)).limit(1).all();
    const row = rows[0];
    return row === undefined ? null : this.#rowToFeedback(row);
  }

  async listByRun(runId: string): Promise<readonly Feedback[]> {
    const rows = this.#database.drizzle
      .select()
      .from(feedback)
      .where(eq(feedback.runId, runId))
      .orderBy(asc(feedback.createdAt), asc(feedback.id))
      .all();
    return rows.map((row) => this.#rowToFeedback(row));
  }

  async updateStatusAndAppendThread(input: FeedbackStatusTransitionPersistenceInput): Promise<Feedback> {
    return this.#database.drizzle.transaction((tx) => {
      const current = tx
        .select()
        .from(feedback)
        .where(eq(feedback.id, input.feedbackId))
        .limit(1)
        .all()[0];
      if (current === undefined) {
        throw new Error(`Feedback '${input.feedbackId}' does not exist.`);
      }
      if (current.status !== input.expectedStatus) {
        throw new FeedbackConcurrentModificationError(
          input.feedbackId,
          input.expectedStatus,
          current.status as FeedbackStatus
        );
      }
      const existingThread = parseJsonValue(feedbackThreadSchema, current.threadJson);
      const nextThread = [...existingThread, input.threadEntry];
      const updated = tx.update(feedback)
        .set({
          status: input.nextStatus,
          threadJson: stringifyJsonValue(feedbackThreadSchema, nextThread),
          updatedAt: input.updatedAt
        })
        .where(and(eq(feedback.id, input.feedbackId), eq(feedback.status, input.expectedStatus)))
        .returning().get();
      if (updated === undefined) {
        throw new Error(`Feedback '${input.feedbackId}' does not exist after update.`);
      }
      return this.#rowToFeedback(updated);
    });
  }

  async appendThreadEntry(input: FeedbackThreadAppendPersistenceInput): Promise<Feedback> {
    return this.#database.drizzle.transaction((tx) => {
      const rows = tx.select().from(feedback).where(eq(feedback.id, input.feedbackId)).limit(1).all();
      const current = rows[0];
      if (current === undefined) {
        throw new Error(`Feedback '${input.feedbackId}' does not exist.`);
      }
      const existingThread = parseJsonValue(feedbackThreadSchema, current.threadJson);
      const nextThread = [...existingThread, input.threadEntry];
      tx.update(feedback)
        .set({
          threadJson: stringifyJsonValue(feedbackThreadSchema, nextThread),
          updatedAt: input.updatedAt
        })
        .where(eq(feedback.id, input.feedbackId))
        .run();
      const updatedRows = tx.select().from(feedback).where(eq(feedback.id, input.feedbackId)).limit(1).all();
      const updated = updatedRows[0];
      if (updated === undefined) {
        throw new Error(`Feedback '${input.feedbackId}' does not exist after update.`);
      }
      return this.#rowToFeedback(updated);
    });
  }

  async updateAnchorOffsets(input: FeedbackAnchorOffsetsPersistenceInput): Promise<Feedback> {
    return this.#database.drizzle.transaction((tx) => {
      const current = tx.select().from(feedback).where(eq(feedback.id, input.feedbackId)).limit(1).all()[0];
      if (current === undefined) {
        throw new Error(`Feedback '${input.feedbackId}' does not exist.`);
      }
      const anchor = parseNullableJsonValue(feedbackAnchorSchema, current.anchorJson);
      if (anchor === null || anchor.kind !== 'artifact_range') {
        throw new Error(`Feedback '${input.feedbackId}' has no artifact_range anchor to repair.`);
      }
      // Persist only the repaired offsets; leave quotedText, status, thread, and updatedAt untouched.
      const repaired = { ...anchor, from: input.from, to: input.to };
      tx.update(feedback)
        .set({ anchorJson: nullableJsonForRow(feedbackAnchorSchema, repaired) })
        .where(eq(feedback.id, input.feedbackId))
        .run();
      const updated = tx.select().from(feedback).where(eq(feedback.id, input.feedbackId)).limit(1).all()[0];
      if (updated === undefined) {
        throw new Error(`Feedback '${input.feedbackId}' does not exist after update.`);
      }
      return this.#rowToFeedback(updated);
    });
  }

  #rowToFeedback(row: typeof feedback.$inferSelect): Feedback {
    const anchor = parseNullableJsonValue(feedbackAnchorSchema, row.anchorJson);
    return validateEntity(feedbackSchema, {
      id: row.id,
      runId: row.runId,
      owner: parseJsonValue(nonModelPrincipalSchema, row.ownerJson),
      tenant: row.tenant,
      target: row.target,
      status: row.status,
      title: row.title,
      body: row.body,
      ...(anchor === null ? {} : { anchor }),
      thread: parseJsonValue(feedbackThreadSchema, row.threadJson),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    });
  }
}

// ---------------------------------------------------------------------------
// Publications
// ---------------------------------------------------------------------------

export class DrizzlePublicationRepository implements PublicationRepository {
  readonly #database;

  constructor(database: SqliteDatabase) {
    this.#database = asInternalSqliteDatabase(database);
  }

  async create(input: CreatePublicationInput): Promise<Publication> {
    const parsed = createPublicationInputSchema.parse(input);
    const parentRows = this.#database.drizzle.select({ id: runs.id }).from(runs).where(eq(runs.id, parsed.runId)).limit(1).all();
    requireParent(parentRows, parsed.runId, 'Run');
    const now = nowIso();
    const entity: Publication = validateEntity(publicationSchema, {
      id: `pub_${randomUUID()}`,
      runId: parsed.runId,
      owner: parsed.owner,
      tenant: parsed.tenant,
      provider: parsed.provider,
      url: parsed.url,
      label: parsed.label,
      frontedResource: parsed.frontedResource,
      createdAt: now,
      updatedAt: now
    });

    this.#database.drizzle.insert(publications).values({
      id: entity.id,
      runId: entity.runId,
      ownerJson: stringifyJsonValue(nonModelPrincipalSchema, entity.owner),
      tenant: entity.tenant,
      provider: entity.provider,
      url: entity.url,
      label: entity.label,
      frontedResourceJson: stringifyJsonValue(frontedResourceSchema, entity.frontedResource),
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt
    }).run();

    return entity;
  }

  async findById(id: string): Promise<Publication | null> {
    const rows = this.#database.drizzle.select().from(publications).where(eq(publications.id, id)).limit(1).all();
    const row = rows[0];
    return row === undefined ? null : this.#rowToPublication(row);
  }

  async listByRun(runId: string): Promise<readonly Publication[]> {
    const rows = this.#database.drizzle
      .select()
      .from(publications)
      .where(eq(publications.runId, runId))
      .orderBy(asc(publications.createdAt), asc(publications.id))
      .all();
    return rows.map((row) => this.#rowToPublication(row));
  }

  #rowToPublication(row: typeof publications.$inferSelect): Publication {
    return validateEntity(publicationSchema, {
      id: row.id,
      runId: row.runId,
      owner: parseJsonValue(nonModelPrincipalSchema, row.ownerJson),
      tenant: row.tenant,
      provider: row.provider,
      url: row.url,
      label: row.label,
      frontedResource: parseJsonValue(frontedResourceSchema, row.frontedResourceJson),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    });
  }
}

// ---------------------------------------------------------------------------
// Pull Requests
// ---------------------------------------------------------------------------

export class DrizzlePullRequestRepository implements PullRequestRepository {
  readonly #database;

  constructor(database: SqliteDatabase) {
    this.#database = asInternalSqliteDatabase(database);
  }

  async create(input: CreatePullRequestInput): Promise<PullRequest> {
    const parsed = createPullRequestInputSchema.parse(input);
    const parentRows = this.#database.drizzle.select({ id: runs.id }).from(runs).where(eq(runs.id, parsed.runId)).limit(1).all();
    requireParent(parentRows, parsed.runId, 'Run');
    const now = nowIso();
    const entity: PullRequest = validateEntity(pullRequestSchema, {
      id: `pr_${randomUUID()}`,
      runId: parsed.runId,
      owner: parsed.owner,
      tenant: parsed.tenant,
      provider: parsed.provider,
      number: parsed.number,
      url: parsed.url,
      state: parsed.state,
      branch: parsed.branch,
      createdAt: now,
      updatedAt: now
    });

    this.#database.drizzle.insert(pullRequests).values({
      id: entity.id,
      runId: entity.runId,
      ownerJson: stringifyJsonValue(nonModelPrincipalSchema, entity.owner),
      tenant: entity.tenant,
      provider: entity.provider,
      number: entity.number,
      url: entity.url,
      state: entity.state,
      branch: entity.branch,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt
    }).run();

    return entity;
  }

  async findById(id: string): Promise<PullRequest | null> {
    const rows = this.#database.drizzle.select().from(pullRequests).where(eq(pullRequests.id, id)).limit(1).all();
    const row = rows[0];
    return row === undefined ? null : this.#rowToPullRequest(row);
  }

  async findByRun(runId: string): Promise<PullRequest | null> {
    const rows = this.#database.drizzle.select().from(pullRequests).where(eq(pullRequests.runId, runId)).limit(1).all();
    const row = rows[0];
    return row === undefined ? null : this.#rowToPullRequest(row);
  }

  async updateState(input: UpdatePullRequestStateInput): Promise<PullRequest> {
    return this.#database.drizzle.transaction((tx) => {
      const current = tx
        .select()
        .from(pullRequests)
        .where(and(eq(pullRequests.runId, input.runId), eq(pullRequests.tenant, input.tenant)))
        .limit(1)
        .all()[0];
      if (current === undefined) {
        throw new Error(`PullRequest for run '${input.runId}' and tenant '${input.tenant}' does not exist.`);
      }
      if (input.expectedState !== undefined && current.state !== input.expectedState) {
        throw new PullRequestStateConflictError();
      }
      tx.update(pullRequests)
        .set({ state: input.state, updatedAt: input.updatedAt })
        .where(eq(pullRequests.id, current.id))
        .run();
      const updated = tx
        .select()
        .from(pullRequests)
        .where(eq(pullRequests.id, current.id))
        .limit(1)
        .all()[0];
      if (updated === undefined) {
        throw new Error(`PullRequest '${current.id}' does not exist after update.`);
      }
      return this.#rowToPullRequest(updated);
    });
  }

  async listOpen(input: ListOpenPullRequestsInput): Promise<readonly PullRequest[]> {
    const rows = this.#database.drizzle
      .select()
      .from(pullRequests)
      .where(and(eq(pullRequests.tenant, input.tenant), eq(pullRequests.state, 'open'),
        input.after === undefined ? undefined : or(gt(pullRequests.createdAt, input.after.createdAt),
          and(eq(pullRequests.createdAt, input.after.createdAt), gt(pullRequests.id, input.after.id)))))
      .orderBy(asc(pullRequests.createdAt), asc(pullRequests.id))
      .limit(input.limit)
      .all();
    return rows.map((row) => this.#rowToPullRequest(row));
  }

  #rowToPullRequest(row: typeof pullRequests.$inferSelect): PullRequest {
    return validateEntity(pullRequestSchema, {
      id: row.id,
      runId: row.runId,
      owner: parseJsonValue(nonModelPrincipalSchema, row.ownerJson),
      tenant: row.tenant,
      provider: row.provider,
      number: row.number,
      url: row.url,
      state: row.state,
      branch: row.branch,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    });
  }
}

// ---------------------------------------------------------------------------
// Run Steps
// ---------------------------------------------------------------------------

export class DrizzleRunStepRepository implements RunStepRepository {
  readonly #database;

  constructor(database: SqliteDatabase) {
    this.#database = asInternalSqliteDatabase(database);
  }

  async create(input: CreateRunStepInput): Promise<RunStep> {
    const parsed = createRunStepInputSchema.parse(input);
    const parentRows = this.#database.drizzle.select({ id: runs.id }).from(runs).where(eq(runs.id, parsed.runId)).limit(1).all();
    requireParent(parentRows, parsed.runId, 'Run');
    const entity: RunStep = validateEntity(runStepSchema, {
      id: `step_${randomUUID()}`,
      runId: parsed.runId,
      phase: parsed.phase,
      step: parsed.step,
      role: parsed.role,
      startedAt: parsed.startedAt,
      endedAt: parsed.endedAt,
      durationMs: parsed.durationMs,
      occurrence: parsed.occurrence,
      checkpointResult: null
    });

    this.#database.drizzle.insert(runSteps).values({
      id: entity.id,
      runId: entity.runId,
      phase: entity.phase,
      step: entity.step,
      role: entity.role,
      startedAt: entity.startedAt,
      endedAt: entity.endedAt,
      durationMs: entity.durationMs,
      occurrenceJson: stringifyJsonValue(occurrenceSchema, entity.occurrence),
      checkpointResultJson: null
    }).run();

    return entity;
  }

  async findById(id: string): Promise<RunStep | null> {
    const rows = this.#database.drizzle.select().from(runSteps).where(eq(runSteps.id, id)).limit(1).all();
    const row = rows[0];
    return row === undefined ? null : this.#rowToRunStep(row);
  }

  async listByRun(runId: string): Promise<readonly RunStep[]> {
    const rows = this.#database.drizzle
      .select()
      .from(runSteps)
      .where(eq(runSteps.runId, runId))
      .orderBy(asc(runSteps.startedAt), asc(runSteps.id))
      .all();
    return rows.map((row) => this.#rowToRunStep(row));
  }

  async updateCheckpoint(input: UpdateRunStepCheckpointInput): Promise<RunStep> {
    const checkpoint = input.checkpointResult;
    if (
      checkpoint !== null &&
      typeof checkpoint === 'object' &&
      !Array.isArray(checkpoint) &&
      (checkpoint as Record<string, unknown>)['kind'] === 'convergence_review'
    ) {
      convergenceCheckpointSchema.parse(checkpoint);
    }

    const parentRow = this.#database.drizzle
      .select({ id: runSteps.id })
      .from(runSteps)
      .innerJoin(runs, eq(runSteps.runId, runs.id))
      .where(and(eq(runSteps.id, input.runStepId), eq(runs.id, input.runId), eq(runs.tenant, input.tenant)))
      .limit(1)
      .all()[0];

    if (parentRow === undefined) {
      throw new Error(`RunStep '${input.runStepId}' not found for run '${input.runId}' and tenant '${input.tenant}'.`);
    }

    const checkpointResultJson = stringifyJsonValue(jsonValueSchema, input.checkpointResult);
    this.#database.drizzle
      .update(runSteps)
      .set({ checkpointResultJson })
      .where(eq(runSteps.id, input.runStepId))
      .run();

    const updatedRow = this.#database.drizzle
      .select()
      .from(runSteps)
      .where(eq(runSteps.id, input.runStepId))
      .limit(1)
      .all()[0];

    if (updatedRow === undefined) {
      throw new Error(`RunStep '${input.runStepId}' not found after update.`);
    }

    return this.#rowToRunStep(updatedRow);
  }

  #rowToRunStep(row: typeof runSteps.$inferSelect): RunStep {
    return rowToRunStepEntity(row);
  }
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export class DrizzleSessionRepository implements SessionRepository {
  readonly #database;

  constructor(database: SqliteDatabase) {
    this.#database = asInternalSqliteDatabase(database);
  }

  async create(input: CreateSessionInput, attemptId?: string): Promise<StoredSession> {
    const parsed = createSessionInputSchema.parse(input);
    // Allocate the per-run sequence and insert atomically so concurrent creates for the same
    // run cannot collide on a stale max. The unique (run_id, sequence) index is the final
    // guard; serial per-run execution makes coalesce(max)+1 sufficient in practice.
    return this.#database.drizzle.transaction((tx) => {
      const parentRows = tx.select({ id: runs.id }).from(runs).where(eq(runs.id, parsed.runId)).limit(1).all();
      requireParent(parentRows, parsed.runId, 'Run');
      if (attemptId !== undefined) {
        const prior = tx.select().from(sessions).where(eq(sessions.id, attemptId)).get();
        if (prior !== undefined) {
          if (prior.runId !== parsed.runId || prior.step !== parsed.step || prior.role !== parsed.role || prior.round !== parsed.round) {
            throw new Error('Session attempt binding mismatch.');
          }
          return this.#rowToSession(prior);
        }
      }
      const maxRow = tx
        .select({ value: sql<number>`coalesce(max(${sessions.sequence}), 0)` })
        .from(sessions)
        .where(eq(sessions.runId, parsed.runId))
        .all()[0];
      const nextSequence = (maxRow?.value ?? 0) + 1;
      const entity: StoredSession = validateEntity(storedSessionSchema, {
        id: attemptId ?? `sess_${randomUUID()}`,
        runId: parsed.runId,
        sequence: nextSequence,
        phase: parsed.phase,
        step: parsed.step,
        role: parsed.role,
        round: parsed.round,
        model: parsed.model,
        inferenceSettings: parsed.inferenceSettings,
        startedAt: parsed.startedAt,
        endedAt: parsed.endedAt,
        durationMs: parsed.durationMs,
        tokens: parsed.tokens,
        usageAvailable: parsed.usageAvailable,
        assistantTurnCount: parsed.assistantTurnCount,
        toolCallCount: parsed.toolCallCount,
        outcome: parsed.outcome,
        ...(parsed.usage === undefined ? {} : { usage: parsed.usage }),
        cost: { ...parsed.cost, usd: null }
      });

      tx.insert(sessions).values({
        id: entity.id,
        runId: entity.runId,
        sequence: entity.sequence,
        phase: entity.phase,
        step: entity.step,
        role: entity.role,
        round: entity.round,
        modelJson: stringifyJsonValue(modelIdentitySchema, entity.model),
        inferenceSettingsJson: stringifyJsonValue(inferenceSettingsSchema, entity.inferenceSettings),
        startedAt: entity.startedAt,
        endedAt: entity.endedAt,
        durationMs: entity.durationMs,
        tokensJson: stringifyJsonValue(tokenBreakdownSchema, entity.tokens),
        usageAvailable: entity.usageAvailable,
        assistantTurnCount: entity.assistantTurnCount,
        toolCallCount: entity.toolCallCount,
        outcome: entity.outcome,
        usageJson: entity.usage === undefined ? null : stringifyJsonValue(sessionUsageSchema, entity.usage),
        costJson: stringifyJsonValue(costSchema, entity.cost)
      }).run();

      return entity;
    });
  }

  async findById(id: string): Promise<StoredSession | null> {
    const rows = this.#database.drizzle.select().from(sessions).where(eq(sessions.id, id)).limit(1).all();
    const row = rows[0];
    return row === undefined ? null : this.#rowToSession(row);
  }

  async listByRun(runId: string): Promise<readonly StoredSession[]> {
    // Deterministic per-run ordering by the allocated sequence; startedAt/id remain only as
    // defensive tie-breakers for any legacy rows that might share a sequence.
    const rows = this.#database.drizzle
      .select()
      .from(sessions)
      .where(eq(sessions.runId, runId))
      .orderBy(asc(sessions.sequence), asc(sessions.startedAt), asc(sessions.id))
      .all();
    return rows.map((row) => this.#rowToSession(row));
  }

  async readPricingSnapshot(tenant: string, runId: string): Promise<{
    sessions: StoredSession[];
    history: ModelRateRecord[];
  }> {
    return this.#database.drizzle.transaction((tx) => {
      const recorded = tx.select().from(sessions).innerJoin(runs, eq(sessions.runId, runs.id))
        .where(and(eq(sessions.runId, runId), eq(runs.tenant, tenant)))
        .orderBy(asc(sessions.sequence), asc(sessions.startedAt), asc(sessions.id))
        .all().map((row) => this.#rowToSession(row.sessions));
      const keys = new Set(recorded.flatMap((session) => session.usage?.groups.flatMap(({ model }) =>
        model === null ? [] : [JSON.stringify([model.provider, model.model])]) ?? []));
      if (keys.size === 0) return { sessions: recorded, history: [] };
      const encodedKeys = JSON.stringify([...keys].map((key) => JSON.parse(key) as [string, string]));
      const history = tx.select().from(configurationRecords).where(and(
        eq(configurationRecords.tenant, tenant),
        sql`${configurationRecords.kind} = 'model_rate_table'`,
        sql`(json_extract(${configurationRecords.settingsJson}, '$.provider'),
              json_extract(${configurationRecords.settingsJson}, '$.model')) IN (
          SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(${encodedKeys})
        )`
      )).all().map((row) => rowToRecord(row) as ModelRateRecord);
      return { sessions: recorded, history };
    });
  }

  #rowToSession(row: typeof sessions.$inferSelect): StoredSession {
    return validateEntity(storedSessionSchema, {
      id: row.id,
      runId: row.runId,
      sequence: row.sequence,
      phase: row.phase,
      step: row.step,
      role: row.role,
      round: row.round,
      model: parseJsonValue(modelIdentitySchema, row.modelJson),
      inferenceSettings: parseJsonValue(inferenceSettingsSchema, row.inferenceSettingsJson),
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      durationMs: row.durationMs,
      tokens: parseJsonValue(tokenBreakdownSchema, row.tokensJson),
      usageAvailable: row.usageAvailable,
      assistantTurnCount: row.assistantTurnCount,
      toolCallCount: row.toolCallCount,
      outcome: row.outcome,
      ...(row.usageJson === null ? {} : { usage: parseJsonValue(sessionUsageSchema, row.usageJson) }),
      cost: parseJsonValue(costSchema, row.costJson)
    });
  }
}

// ---------------------------------------------------------------------------
// Test Results
// ---------------------------------------------------------------------------

function mapTestingGuide(row: typeof testingGuides.$inferSelect): StoredTestingGuide {
  const { id, runId, revision, instructions, itemsJson, createdAt, runStepId } = row;
  return { ...testingGuideSchema.parse({ id, runId, revision, instructions, items: JSON.parse(itemsJson), createdAt }), runStepId };
}

export class DrizzleTestingGuideRepository implements TestingGuideRepository {
  readonly #database;

  constructor(database: SqliteDatabase) {
    this.#database = asInternalSqliteDatabase(database);
  }

  async create(input: StoredTestingGuide & { readonly tenant: string }): Promise<StoredTestingGuide> {
    const { runId, tenant, runStepId } = input;
    return this.#database.drizzle.transaction(tx => {
      const owner = tx.select({ id: runs.id }).from(runs).innerJoin(runSteps, eq(runSteps.runId, runs.id))
        .where(and(eq(runs.id, runId), eq(runs.tenant, tenant), eq(runSteps.id, runStepId),
          eq(runSteps.step, 'implementation.testing_guide'))).get();
      if (!owner) throw new Error('Invalid testing guide occurrence for run and tenant.');
      const prior = tx.select().from(testingGuides)
        .where(and(eq(testingGuides.runId, runId), eq(testingGuides.tenant, tenant), eq(testingGuides.runStepId, runStepId))).get();
      if (prior) return mapTestingGuide(prior);
      const { id, revision, instructions, items, createdAt } = input;
      const guide = testingGuideSchema.parse({ id, runId, revision, instructions, items, createdAt });
      const row = tx.insert(testingGuides).values({
        id: guide.id, runId, tenant, runStepId, revision: guide.revision, instructions: guide.instructions,
        itemsJson: JSON.stringify(guide.items), createdAt: guide.createdAt
      }).returning().get();
      return mapTestingGuide(row);
    }, { behavior: 'immediate' });
  }

  async findLatestByRun({ runId, tenant }: { runId: string; tenant: string }): Promise<StoredTestingGuide | null> {
    const row = this.#database.drizzle.select().from(testingGuides)
      .innerJoin(runs, and(eq(runs.id, testingGuides.runId), eq(runs.tenant, testingGuides.tenant)))
      .where(and(eq(testingGuides.runId, runId), eq(testingGuides.tenant, tenant)))
      .orderBy(desc(testingGuides.revision)).limit(1).get();
    return row ? mapTestingGuide(row.testing_guides) : null;
  }
}

export class DrizzleTestResultRepository implements TestResultRepository {
  readonly #database;

  constructor(database: SqliteDatabase) {
    this.#database = asInternalSqliteDatabase(database);
  }

  async create(input: CreateTestResultInput): Promise<TestResult> {
    const parsed = createTestResultInputSchema.parse(input);
    const parentRows = this.#database.drizzle.select({ id: runs.id }).from(runs).where(eq(runs.id, parsed.runId)).limit(1).all();
    requireParent(parentRows, parsed.runId, 'Run');
    const now = nowIso();
    const entity: TestResult = validateEntity(testResultSchema, {
      id: `test_${randomUUID()}`,
      runId: parsed.runId,
      tester: parsed.tester,
      outcome: parsed.outcome,
      ...(parsed.evidence === undefined ? {} : { evidence: parsed.evidence }),
      feedbackRefs: parsed.feedbackRefs,
      createdAt: now,
      updatedAt: now
    });

    this.#database.drizzle.insert(testResults).values({
      id: entity.id,
      runId: entity.runId,
      testerJson: stringifyJsonValue(principalSchema, entity.tester),
      outcome: entity.outcome,
      evidenceJson: nullableJsonForRow(testResultEvidenceSchema, entity.evidence),
      feedbackRefsJson: stringifyJsonValue(feedbackRefsSchema, entity.feedbackRefs),
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt
    }).run();

    return entity;
  }

  async findById(id: string): Promise<TestResult | null> {
    const rows = this.#database.drizzle.select().from(testResults).where(eq(testResults.id, id)).limit(1).all();
    const row = rows[0];
    return row === undefined ? null : this.#rowToTestResult(row);
  }

  async listByRun(runId: string): Promise<readonly TestResult[]> {
    const rows = this.#database.drizzle
      .select()
      .from(testResults)
      .where(eq(testResults.runId, runId))
      .orderBy(asc(testResults.createdAt), asc(testResults.id))
      .all();
    return rows.map((row) => this.#rowToTestResult(row));
  }

  #rowToTestResult(row: typeof testResults.$inferSelect): TestResult {
    const evidence = parseNullableJsonValue(testResultEvidenceSchema, row.evidenceJson);
    return validateEntity(testResultSchema, {
      id: row.id,
      runId: row.runId,
      tester: parseJsonValue(principalSchema, row.testerJson),
      outcome: row.outcome,
      ...(evidence === null ? {} : { evidence }),
      feedbackRefs: parseJsonValue(feedbackRefsSchema, row.feedbackRefsJson),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    });
  }
}

// ---------------------------------------------------------------------------
// Conversation Ingress
// ---------------------------------------------------------------------------

export class DrizzleConversationIngressRepository implements ConversationIngressRepository {
  readonly #database;

  constructor(database: SqliteDatabase) {
    this.#database = asInternalSqliteDatabase(database);
  }

  async createConversationTopicMessageAndRun(
    input: CreateConversationTopicMessageAndRunInput
  ): Promise<CreateConversationTopicMessageAndRunResult> {
    const topicId = `topic_${randomUUID()}`;

    return this.#database.drizzle.transaction((tx) => {
      const now = nowIso();

      // 1. Check project exists
      const parentRows = tx.select({ id: projects.id }).from(projects).where(eq(projects.id, input.conversation.projectId)).limit(1).all();
      requireParent(parentRows, input.conversation.projectId, 'Project');

      // 2. Create conversation with activeTopicId: null
      const convId = `conv_${randomUUID()}`;
      const conv = validateEntity(conversationSchema, {
        id: convId,
        projectId: input.conversation.projectId,
        owner: input.conversation.owner,
        tenant: input.conversation.tenant,
        identity: input.conversation.identity,
        ...(input.conversation.channel === undefined ? {} : { channel: input.conversation.channel }),
        activeTopicId: null,
        createdAt: now,
        updatedAt: now
      });
      tx.insert(conversations).values({
        id: conv.id,
        projectId: conv.projectId,
        ownerJson: stringifyJsonValue(nonModelPrincipalSchema, conv.owner),
        tenant: conv.tenant,
        identity: conv.identity,
        channelJson: nullableJsonForRow(channelReferenceSchema, conv.channel),
        activeTopicId: null,
        createdAt: conv.createdAt,
        updatedAt: conv.updatedAt
      }).run();

      // 3. Create main topic
      const topic = validateEntity(topicSchema, {
        id: topicId,
        conversationId: conv.id,
        owner: input.topic.owner,
        tenant: input.topic.tenant,
        title: input.topic.title,
        kind: input.topic.kind,
        createdAt: now,
        updatedAt: now
      });
      tx.insert(topics).values({
        id: topic.id,
        conversationId: topic.conversationId,
        ownerJson: stringifyJsonValue(nonModelPrincipalSchema, topic.owner),
        tenant: topic.tenant,
        title: topic.title,
        kind: topic.kind,
        createdAt: topic.createdAt,
        updatedAt: topic.updatedAt
      }).run();

      // 4. Update conversation activeTopicId
      tx.update(conversations)
        .set({ activeTopicId: topic.id, updatedAt: now })
        .where(eq(conversations.id, conv.id))
        .run();
      const updatedConv = validateEntity(conversationSchema, { ...conv, activeTopicId: topic.id, updatedAt: now });

      // 5. Optionally create inbound message
      let message: Message | undefined;
      if (input.message !== undefined) {
        const msg = input.message;
        message = validateEntity(messageSchema, {
          id: `msg_${randomUUID()}`,
          topicId: topic.id,
          owner: msg.owner,
          tenant: msg.tenant,
          author: msg.author,
          direction: msg.direction,
          body: msg.body,
          ...(msg.intent === undefined ? {} : { intent: msg.intent }),
          createdAt: now
        });
        tx.insert(messages).values({
          id: message.id,
          topicId: message.topicId,
          ownerJson: stringifyJsonValue(nonModelPrincipalSchema, message.owner),
          tenant: message.tenant,
          authorJson: stringifyJsonValue(principalSchema, message.author),
          direction: message.direction,
          body: message.body,
          intent: message.intent ?? null,
          createdAt: message.createdAt
        }).run();
      }

      // 6. Create run using currentStep and terminal supplied by the orchestrator
      const run = validateEntity(runSchema, {
        id: `run_${randomUUID()}`,
        topicId: topic.id,
        owner: input.run.owner,
        tenant: input.run.tenant,
        workKind: input.run.workKind,
        currentStep: input.run.currentStep,
        terminal: input.run.terminal,
        ...(input.run.trackedIssue === undefined ? {} : { trackedIssue: input.run.trackedIssue }),
        ...(input.run.testingGuideResult === undefined ? {} : { testingGuideResult: input.run.testingGuideResult }),
        createdAt: now,
        updatedAt: now
      });
      try {
        tx.insert(runs).values({
          id: run.id,
          topicId: run.topicId,
          ownerJson: stringifyJsonValue(nonModelPrincipalSchema, run.owner),
          tenant: run.tenant,
          workKind: run.workKind,
          currentStep: run.currentStep,
          terminal: run.terminal,
          trackedIssueJson: nullableJsonForRow(trackedIssueSchema, run.trackedIssue),
          testingGuideResultJson: nullableJsonForRow(testingGuideResultSchema, run.testingGuideResult),
          createdAt: run.createdAt,
          updatedAt: run.updatedAt
        }).run();
      } catch (error) {
        if (isActiveRunConstraintViolation(error)) {
          throw new ActiveRunConflictPersistenceError(run.topicId, null);
        }
        throw error;
      }

      // 7. Create initial RunStep using shared helper
      const runStep = buildRunStepInsideTransaction(tx, run.id, input.runStep);

      return { conversation: updatedConv, topic, ...(message !== undefined ? { message } : {}), run, runStep };
    });
  }
}

// ---------------------------------------------------------------------------
// RunWorkspaceMetadata repository — internal only, never exposed publicly
// ---------------------------------------------------------------------------

export class DrizzleRunWorkspaceMetadataRepository implements RunWorkspaceMetadataRepository {
  readonly #database: ReturnType<typeof asInternalSqliteDatabase>;

  constructor(database: SqliteDatabase) {
    this.#database = asInternalSqliteDatabase(database);
  }

  async upsert(input: UpsertRunWorkspaceMetadataInput): Promise<void> {
    this.#database.drizzle
      .insert(runWorkspaceMetadata)
      .values({
        runId: input.runId,
        workspaceHandle: input.workspaceHandle,
        workspaceRepoRoot: input.workspaceRepoRoot,
        provisionedBaseRef: input.provisionedBaseRef ?? null,
        generation: randomUUID(),
        createdAt: input.createdAt
      })
      .onConflictDoUpdate({
        target: runWorkspaceMetadata.runId,
        set: {
          workspaceHandle: input.workspaceHandle,
          workspaceRepoRoot: input.workspaceRepoRoot,
          generation: sql`case when ${runWorkspaceMetadata.workspaceHandle} <> ${input.workspaceHandle}
            or ${runWorkspaceMetadata.workspaceRepoRoot} <> ${input.workspaceRepoRoot} then ${randomUUID()} else ${runWorkspaceMetadata.generation} end`,
          enrollmentProof: sql`case when ${runWorkspaceMetadata.workspaceHandle} <> ${input.workspaceHandle}
            or ${runWorkspaceMetadata.workspaceRepoRoot} <> ${input.workspaceRepoRoot} then null else ${runWorkspaceMetadata.enrollmentProof} end`,
          // Preserve an existing non-null provisionedBaseRef so idempotent re-materializations
          // (which may reconstruct an approximate ref) do not overwrite the exact ref captured
          // during first provisioning.
          provisionedBaseRef: sql`COALESCE(${runWorkspaceMetadata.provisionedBaseRef}, ${input.provisionedBaseRef ?? null})`
        }
      })
      .run();
  }

  async findByRunId(runId: string): Promise<RunWorkspaceMetadata | null> {
    const rows = this.#database.drizzle
      .select()
      .from(runWorkspaceMetadata)
      .where(eq(runWorkspaceMetadata.runId, runId))
      .limit(1)
      .all();
    const row = rows[0];
    if (row === undefined) return null;
    return {
      runId: row.runId,
      workspaceHandle: row.workspaceHandle,
      workspaceRepoRoot: row.workspaceRepoRoot,
      provisionedBaseRef: row.provisionedBaseRef ?? null,
      createdAt: row.createdAt
    };
  }
}

// ---------------------------------------------------------------------------
// Repository collection factory
// ---------------------------------------------------------------------------

export interface DrizzleDomainRepositories extends DomainRepositories {
  projects: DrizzleProjectRepository;
  conversations: DrizzleConversationRepository;
  topics: DrizzleTopicRepository;
  messages: DrizzleMessageRepository;
  runs: DrizzleRunRepository;
  artifacts: DrizzleArtifactRepository;
  feedback: DrizzleFeedbackRepository;
  publications: DrizzlePublicationRepository;
  pullRequests: DrizzlePullRequestRepository;
  runSteps: DrizzleRunStepRepository;
  sessions: DrizzleSessionRepository;
  testResults: DrizzleTestResultRepository;
  testingGuides: DrizzleTestingGuideRepository;
  runWorkspaceMetadata: DrizzleRunWorkspaceMetadataRepository;
}

export function createDrizzleDomainRepositories(database: SqliteDatabase): DrizzleDomainRepositories {
  return {
    projects: new DrizzleProjectRepository(database),
    conversations: new DrizzleConversationRepository(database),
    topics: new DrizzleTopicRepository(database),
    messages: new DrizzleMessageRepository(database),
    runs: new DrizzleRunRepository(database),
    artifacts: new DrizzleArtifactRepository(database),
    feedback: new DrizzleFeedbackRepository(database),
    publications: new DrizzlePublicationRepository(database),
    pullRequests: new DrizzlePullRequestRepository(database),
    runSteps: new DrizzleRunStepRepository(database),
    sessions: new DrizzleSessionRepository(database),
    testResults: new DrizzleTestResultRepository(database),
    testingGuides: new DrizzleTestingGuideRepository(database),
    runWorkspaceMetadata: new DrizzleRunWorkspaceMetadataRepository(database)
  };
}
