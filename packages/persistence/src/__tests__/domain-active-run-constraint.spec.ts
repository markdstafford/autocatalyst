import { describe, expect, it } from 'vitest';

import {
  ActiveRunConflictPersistenceError,
  DrizzleConversationIngressRepository,
  createDrizzleDomainRepositories,
  createSqliteDatabase,
  isActiveRunConstraintViolation,
  migrateSqliteDatabase,
  withTempDatabasePath
} from '../index.js';

const owner = { id: 'user_1', kind: 'human', tenantId: 'tenant_1', displayName: 'Ada' } as const;

async function setupProjectConvTopic() {
  const database = createSqliteDatabase({ path: ':memory:' });
  await migrateSqliteDatabase(database);
  const repos = createDrizzleDomainRepositories(database);

  const project = await repos.projects.create({
    owner,
    tenant: 'tenant_1',
    displayName: 'P',
    repoUrl: 'https://example.test',
    hostRepository: { provider: 'github', owner: 'test', name: 'repo' },
    workspaceRootOverride: null,
    issueTrackerSetting: null,
    codeHostSetting: null,
    credentialRefs: []
  });
  const conv = await repos.conversations.create({
    projectId: project.id,
    owner,
    tenant: 'tenant_1',
    identity: 'conv-c',
    activeTopicId: null
  });
  const topic = await repos.topics.create({
    conversationId: conv.id,
    owner,
    tenant: 'tenant_1',
    title: 'T',
    kind: 'main'
  });
  return { database, repos, topic };
}

describe('one-active-run-per-topic constraint', () => {
  it('rejects a second non-terminal run for the same topic', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const database = createSqliteDatabase({ path: databasePath });
      await migrateSqliteDatabase(database);
      const repos = createDrizzleDomainRepositories(database);

      const project = await repos.projects.create({
        owner,
        tenant: 'tenant_1',
        displayName: 'P',
        repoUrl: 'https://example.test',
        hostRepository: { provider: 'github', owner: 'test', name: 'repo' },
        workspaceRootOverride: null,
        issueTrackerSetting: null,
        codeHostSetting: null,
        credentialRefs: []
      });
      const conv = await repos.conversations.create({
        projectId: project.id,
        owner,
        tenant: 'tenant_1',
        identity: 'conv-c',
        activeTopicId: null
      });
      const topic = await repos.topics.create({
        conversationId: conv.id,
        owner,
        tenant: 'tenant_1',
        title: 'T',
        kind: 'main'
      });

      await repos.runs.create({
        topicId: topic.id,
        owner,
        tenant: 'tenant_1',
        workKind: 'feature',
        currentStep: 'spec.author',
        terminal: false
      });
      await expect(
        repos.runs.create({
          topicId: topic.id,
          owner,
          tenant: 'tenant_1',
          workKind: 'feature',
          currentStep: 'spec.author',
          terminal: false
        })
      ).rejects.toThrow();

      database.close();
    });
  });

  it('allows a non-terminal run after a terminal run for the same topic', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const database = createSqliteDatabase({ path: databasePath });
      await migrateSqliteDatabase(database);
      const repos = createDrizzleDomainRepositories(database);

      const project = await repos.projects.create({
        owner,
        tenant: 'tenant_1',
        displayName: 'P',
        repoUrl: 'https://example.test',
        hostRepository: { provider: 'github', owner: 'test', name: 'repo' },
        workspaceRootOverride: null,
        issueTrackerSetting: null,
        codeHostSetting: null,
        credentialRefs: []
      });
      const conv = await repos.conversations.create({
        projectId: project.id,
        owner,
        tenant: 'tenant_1',
        identity: 'conv-c',
        activeTopicId: null
      });
      const topic = await repos.topics.create({
        conversationId: conv.id,
        owner,
        tenant: 'tenant_1',
        title: 'T',
        kind: 'main'
      });

      await repos.runs.create({
        topicId: topic.id,
        owner,
        tenant: 'tenant_1',
        workKind: 'feature',
        currentStep: 'done',
        terminal: true
      });
      const run2 = await repos.runs.create({
        topicId: topic.id,
        owner,
        tenant: 'tenant_1',
        workKind: 'feature',
        currentStep: 'spec.author',
        terminal: false
      });
      expect(run2.terminal).toBe(false);

      database.close();
    });
  });

  it('proves invariant is keyed on topic, not conversation — two non-terminal runs for two topics in same conversation both succeed', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const database = createSqliteDatabase({ path: databasePath });
      await migrateSqliteDatabase(database);
      const repos = createDrizzleDomainRepositories(database);

      const project = await repos.projects.create({
        owner,
        tenant: 'tenant_1',
        displayName: 'P',
        repoUrl: 'https://example.test',
        hostRepository: { provider: 'github', owner: 'test', name: 'repo' },
        workspaceRootOverride: null,
        issueTrackerSetting: null,
        codeHostSetting: null,
        credentialRefs: []
      });
      const conv = await repos.conversations.create({
        projectId: project.id,
        owner,
        tenant: 'tenant_1',
        identity: 'conv-c',
        activeTopicId: null
      });
      const topic1 = await repos.topics.create({
        conversationId: conv.id,
        owner,
        tenant: 'tenant_1',
        title: 'Main',
        kind: 'main'
      });
      const topic2 = await repos.topics.create({
        conversationId: conv.id,
        owner,
        tenant: 'tenant_1',
        title: 'Side',
        kind: 'side'
      });

      const run1 = await repos.runs.create({
        topicId: topic1.id,
        owner,
        tenant: 'tenant_1',
        workKind: 'feature',
        currentStep: 'spec.author',
        terminal: false
      });
      const run2 = await repos.runs.create({
        topicId: topic2.id,
        owner,
        tenant: 'tenant_1',
        workKind: 'feature',
        currentStep: 'spec.author',
        terminal: false
      });
      expect(run1.topicId).toBe(topic1.id);
      expect(run2.topicId).toBe(topic2.id);

      database.close();
    });
  });
});

describe('DrizzleConversationIngressRepository — active-run constraint', () => {
  it('produces a constraint-violation error recognised by isActiveRunConstraintViolation when a second non-terminal run is added to an ingress-created topic', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const database = createSqliteDatabase({ path: databasePath });
      await migrateSqliteDatabase(database);
      const repos = createDrizzleDomainRepositories(database);

      const project = await repos.projects.create({
        owner,
        tenant: 'tenant_1',
        displayName: 'P',
        repoUrl: 'https://example.test',
        hostRepository: { provider: 'github', owner: 'test', name: 'repo' },
        workspaceRootOverride: null,
        issueTrackerSetting: null,
        codeHostSetting: null,
        credentialRefs: []
      });

      const ingress = new DrizzleConversationIngressRepository(database);
      const startedAt = new Date().toISOString();

      const first = await ingress.createConversationTopicMessageAndRun({
        conversation: {
          projectId: project.id,
          owner,
          tenant: 'tenant_1',
          identity: 'conv-ingress-1',
          activeTopicId: null
        },
        topic: {
          owner,
          tenant: 'tenant_1',
          title: 'T',
          kind: 'main'
        },
        run: {
          owner,
          tenant: 'tenant_1',
          workKind: 'feature',
          currentStep: 'intake',
          terminal: false
        },
        runStep: {
          phase: null,
          step: 'intake',
          role: 'none',
          startedAt,
          endedAt: null,
          durationMs: null
        }
      });

      // A second non-terminal run on the same ingress-created topic must violate
      // the runs_one_active_per_topic constraint. The wrapper that converts the
      // raw SqliteError into ActiveRunConflictPersistenceError lives inside the
      // ingress repository itself; here we assert that the violation is
      // recognisable by the shared helper so the wrapper would fire.
      let caught: unknown;
      try {
        await repos.runs.create({
          topicId: first.topic.id,
          owner,
          tenant: 'tenant_1',
          workKind: 'feature',
          currentStep: 'intake',
          terminal: false
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeDefined();
      expect(isActiveRunConstraintViolation(caught)).toBe(true);

      // The typed error class itself remains importable and instantiable.
      const typed = new ActiveRunConflictPersistenceError(first.topic.id, first.run.id);
      expect(typed.name).toBe('ActiveRunConflictPersistenceError');
      expect(typed.topicId).toBe(first.topic.id);
      expect(typed.existingRunId).toBe(first.run.id);

      database.close();
    });
  });
});

describe('findActiveByTopic', () => {
  it('returns the active run for a topic', async () => {
    const { database, repos, topic } = await setupProjectConvTopic();

    const run = await repos.runs.create({
      topicId: topic.id,
      owner,
      tenant: 'tenant_1',
      workKind: 'feature',
      currentStep: 'spec.author',
      terminal: false
    });

    const found = await repos.runs.findActiveByTopic(topic.id);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(run.id);
    expect(found?.terminal).toBe(false);

    database.close();
  });

  it('returns null when no run exists for a topic', async () => {
    const { database, repos, topic } = await setupProjectConvTopic();

    const found = await repos.runs.findActiveByTopic(topic.id);
    expect(found).toBeNull();

    database.close();
  });

  it('returns null when only a terminal run exists for the topic', async () => {
    const { database, repos, topic } = await setupProjectConvTopic();

    await repos.runs.create({
      topicId: topic.id,
      owner,
      tenant: 'tenant_1',
      workKind: 'feature',
      currentStep: 'done',
      terminal: true
    });

    const found = await repos.runs.findActiveByTopic(topic.id);
    expect(found).toBeNull();

    database.close();
  });
});
