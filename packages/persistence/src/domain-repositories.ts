import { randomUUID } from 'node:crypto';

import { and, asc, count, desc, eq, isNull } from 'drizzle-orm';
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
  Message,
  Project,
  Publication,
  PullRequest,
  Run,
  RunStep,
  Session,
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
  sessionSchema,
  testResultEvidenceSchema,
  testResultSchema,
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
  FeedbackRepository,
  FeedbackStatusTransitionPersistenceInput,
  FeedbackThreadAppendPersistenceInput,
  LifecycleRunStepInput,
  ListRunsByTenantOptions,
  MessageRepository,
  ProjectRepository,
  PublicationRepository,
  PullRequestRepository,
  RecordRunLifecycleStartInput,
  RecordRunLifecycleStartResult,
  RecordRunStepTransitionInput,
  RecordRunStepTransitionResult,
  RunRepository,
  RunWorkspaceMetadata,
  RunWorkspaceMetadataRepository,
  UpsertRunWorkspaceMetadataInput,
  RunStepRepository,
  SessionRepository,
  TestResultRepository,
  TopicRepository,
  UpdateRunStepCheckpointInput
} from '@autocatalyst/core';
import { FeedbackConcurrentModificationError } from '@autocatalyst/core';

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
  testResults,
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

function buildRunStepInsideTransaction(tx: DrizzleTx, runId: string, input: LifecycleRunStepInput): RunStep {
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
    checkpointResult: null
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
    checkpointResultJson: null
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

  async findById(id: string): Promise<Project | null> {
    const rows = this.#database.drizzle.select().from(projects).where(eq(projects.id, id)).limit(1).all();
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    return this.#rowToProject(row);
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

  async listByTenant(tenant: string, options: ListRunsByTenantOptions = {}): Promise<readonly Run[]> {
    const limit = normalizeRunListLimit(options.limit);
    const rows = this.#database.drizzle
      .select()
      .from(runs)
      .where(eq(runs.tenant, tenant))
      .orderBy(desc(runs.createdAt), desc(runs.id))
      .limit(limit)
      .all();
    return rows.map((row) => this.#rowToRun(row));
  }

  #rowToRun(row: typeof runs.$inferSelect): Run {
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
      const updatedRows = tx.update(runs)
        .set({
          currentStep: input.currentStep,
          terminal: input.terminal,
          failureReason: input.currentStep === 'failed' ? (input.failureReason ?? null) : null,
          updatedAt: nowIso()
        })
        .where(eq(runs.id, input.runId))
        .returning()
        .all();
      if (updatedRows[0] === undefined) {
        throw new Error(`Run '${input.runId}' does not exist.`);
      }
      const run = this.#rowToRun(updatedRows[0]);
      if (input.sourceRunStepId !== undefined && input.checkpointResult !== undefined) {
        const json = stringifyJsonValue(jsonValueSchema, input.checkpointResult);
        tx.update(runSteps)
          .set({ checkpointResultJson: json })
          .where(eq(runSteps.id, input.sourceRunStepId))
          .run();
      }
      const runStep = buildRunStepInsideTransaction(tx, run.id, input.runStep);
      return { run, runStep };
    });
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
    const parsed = createFeedbackInputSchema.parse(input);
    const parentRows = this.#database.drizzle.select({ id: runs.id }).from(runs).where(eq(runs.id, parsed.runId)).limit(1).all();
    requireParent(parentRows, parsed.runId, 'Run');
    const now = nowIso();
    const entity: Feedback = validateEntity(feedbackSchema, {
      id: `fb_${randomUUID()}`,
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

    this.#database.drizzle.insert(feedback).values({
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
    }).run();

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
      tx.update(feedback)
        .set({
          status: input.nextStatus,
          threadJson: stringifyJsonValue(feedbackThreadSchema, nextThread),
          updatedAt: input.updatedAt
        })
        .where(eq(feedback.id, input.feedbackId))
        .run();
      const updated = tx
        .select()
        .from(feedback)
        .where(eq(feedback.id, input.feedbackId))
        .limit(1)
        .all()[0];
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

  async create(input: CreateSessionInput): Promise<Session> {
    const parsed = createSessionInputSchema.parse(input);
    const parentRows = this.#database.drizzle.select({ id: runs.id }).from(runs).where(eq(runs.id, parsed.runId)).limit(1).all();
    requireParent(parentRows, parsed.runId, 'Run');
    const entity: Session = validateEntity(sessionSchema, {
      id: `sess_${randomUUID()}`,
      runId: parsed.runId,
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
      cost: parsed.cost
    });

    this.#database.drizzle.insert(sessions).values({
      id: entity.id,
      runId: entity.runId,
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
      costJson: stringifyJsonValue(costSchema, entity.cost)
    }).run();

    return entity;
  }

  async findById(id: string): Promise<Session | null> {
    const rows = this.#database.drizzle.select().from(sessions).where(eq(sessions.id, id)).limit(1).all();
    const row = rows[0];
    return row === undefined ? null : this.#rowToSession(row);
  }

  async listByRun(runId: string): Promise<readonly Session[]> {
    const rows = this.#database.drizzle
      .select()
      .from(sessions)
      .where(eq(sessions.runId, runId))
      .orderBy(asc(sessions.startedAt), asc(sessions.id))
      .all();
    return rows.map((row) => this.#rowToSession(row));
  }

  #rowToSession(row: typeof sessions.$inferSelect): Session {
    return validateEntity(sessionSchema, {
      id: row.id,
      runId: row.runId,
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
      cost: parseJsonValue(costSchema, row.costJson)
    });
  }
}

// ---------------------------------------------------------------------------
// Test Results
// ---------------------------------------------------------------------------

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
        createdAt: input.createdAt
      })
      .onConflictDoUpdate({
        target: runWorkspaceMetadata.runId,
        set: {
          workspaceHandle: input.workspaceHandle,
          workspaceRepoRoot: input.workspaceRepoRoot
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
    runWorkspaceMetadata: new DrizzleRunWorkspaceMetadataRepository(database)
  };
}
