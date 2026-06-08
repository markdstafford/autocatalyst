import { describe, expect, it } from 'vitest';

import {
  asInternalSqliteDatabase,
  createDrizzleDomainRepositories,
  createSqliteDatabase,
  migrateSqliteDatabase,
  withTempDatabasePath
} from '../index.js';

const owner = { id: 'user_1', kind: 'human', tenantId: 'tenant_1', displayName: 'Ada' } as const;

describe('recordRunLifecycleStart', () => {
  it('inserts run and initial RunStep atomically', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const database = createSqliteDatabase({ path: databasePath });
      await migrateSqliteDatabase(database);
      const repos = createDrizzleDomainRepositories(database);

      const project = await repos.projects.create({
        owner, tenant: 'tenant_1', displayName: 'P', repoUrl: 'https://example.test',
        hostRepository: { provider: 'github', owner: 'test', name: 'repo' },
        workspaceRootOverride: null, issueTrackerSetting: null, codeHostSetting: null, credentialRefs: []
      });
      const conv = await repos.conversations.create({ projectId: project.id, owner, tenant: 'tenant_1', identity: 'conv-c', activeTopicId: null });
      const topic = await repos.topics.create({ conversationId: conv.id, owner, tenant: 'tenant_1', title: 'T', kind: 'main' });

      const startedAt = new Date().toISOString();
      const result = await repos.runs.recordRunLifecycleStart({
        run: { topicId: topic.id, owner, tenant: 'tenant_1', workKind: 'feature', currentStep: 'intake', terminal: false },
        runStep: { phase: null, step: 'intake', role: 'none', startedAt, endedAt: null, durationMs: null }
      });

      expect(result.run.currentStep).toBe('intake');
      expect(result.run.terminal).toBe(false);
      expect(result.runStep.step).toBe('intake');
      expect(result.runStep.occurrence.index).toBe(0);
      expect(result.runStep.occurrence.attempt).toBe(1);
      expect(result.runStep.role).toBe('none');

      const runsForTopic = await repos.runs.listByTopic(topic.id);
      expect(runsForTopic).toHaveLength(1);
      const stepsForRun = await repos.runSteps.listByRun(result.run.id);
      expect(stepsForRun).toHaveLength(1);

      database.close();
    });
  });

  it('rolls back run insert if RunStep insert fails', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const database = createSqliteDatabase({ path: databasePath });
      await migrateSqliteDatabase(database);
      const repos = createDrizzleDomainRepositories(database);

      const project = await repos.projects.create({
        owner, tenant: 'tenant_1', displayName: 'P', repoUrl: 'https://example.test',
        hostRepository: { provider: 'github', owner: 'test', name: 'repo' },
        workspaceRootOverride: null, issueTrackerSetting: null, codeHostSetting: null, credentialRefs: []
      });
      const conv = await repos.conversations.create({ projectId: project.id, owner, tenant: 'tenant_1', identity: 'conv-c', activeTopicId: null });
      const topic = await repos.topics.create({ conversationId: conv.id, owner, tenant: 'tenant_1', title: 'T', kind: 'main' });

      asInternalSqliteDatabase(database).client
        .prepare(`CREATE TRIGGER abort_run_steps_insert BEFORE INSERT ON run_steps BEGIN SELECT RAISE(ABORT, 'blocked'); END`)
        .run();

      await expect(repos.runs.recordRunLifecycleStart({
        run: { topicId: topic.id, owner, tenant: 'tenant_1', workKind: 'feature', currentStep: 'intake', terminal: false },
        runStep: { phase: null, step: 'intake', role: 'none', startedAt: new Date().toISOString(), endedAt: null, durationMs: null }
      })).rejects.toThrow();

      asInternalSqliteDatabase(database).client
        .prepare(`DROP TRIGGER abort_run_steps_insert`)
        .run();

      const runsForTopic = await repos.runs.listByTopic(topic.id);
      expect(runsForTopic).toHaveLength(0);

      database.close();
    });
  });
});

describe('recordRunStepTransition', () => {
  it('updates currentStep and terminal, inserts RunStep with computed occurrence', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const database = createSqliteDatabase({ path: databasePath });
      await migrateSqliteDatabase(database);
      const repos = createDrizzleDomainRepositories(database);

      const project = await repos.projects.create({
        owner, tenant: 'tenant_1', displayName: 'P', repoUrl: 'https://example.test',
        hostRepository: { provider: 'github', owner: 'test', name: 'repo' },
        workspaceRootOverride: null, issueTrackerSetting: null, codeHostSetting: null, credentialRefs: []
      });
      const conv = await repos.conversations.create({ projectId: project.id, owner, tenant: 'tenant_1', identity: 'conv-c', activeTopicId: null });
      const topic = await repos.topics.create({ conversationId: conv.id, owner, tenant: 'tenant_1', title: 'T', kind: 'main' });

      const startResult = await repos.runs.recordRunLifecycleStart({
        run: { topicId: topic.id, owner, tenant: 'tenant_1', workKind: 'feature', currentStep: 'intake', terminal: false },
        runStep: { phase: null, step: 'intake', role: 'none', startedAt: new Date().toISOString(), endedAt: null, durationMs: null }
      });
      const runId = startResult.run.id;

      const t1 = await repos.runs.recordRunStepTransition({
        runId,
        currentStep: 'spec.author',
        terminal: false,
        runStep: { phase: 'spec', step: 'spec.author', role: 'none', startedAt: new Date().toISOString(), endedAt: null, durationMs: null }
      });
      expect(t1.run.currentStep).toBe('spec.author');
      expect(t1.run.terminal).toBe(false);
      expect(t1.runStep.occurrence.index).toBe(1);
      expect(t1.runStep.occurrence.attempt).toBe(1);

      const t2 = await repos.runs.recordRunStepTransition({
        runId,
        currentStep: 'spec.author',
        terminal: false,
        runStep: { phase: 'spec', step: 'spec.author', role: 'none', startedAt: new Date().toISOString(), endedAt: null, durationMs: null }
      });
      expect(t2.runStep.occurrence.index).toBe(2);
      expect(t2.runStep.occurrence.attempt).toBe(2);

      database.close();
    });
  });

  it('rolls back run update if RunStep insert fails', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const database = createSqliteDatabase({ path: databasePath });
      await migrateSqliteDatabase(database);
      const repos = createDrizzleDomainRepositories(database);

      const project = await repos.projects.create({
        owner, tenant: 'tenant_1', displayName: 'P', repoUrl: 'https://example.test',
        hostRepository: { provider: 'github', owner: 'test', name: 'repo' },
        workspaceRootOverride: null, issueTrackerSetting: null, codeHostSetting: null, credentialRefs: []
      });
      const conv = await repos.conversations.create({ projectId: project.id, owner, tenant: 'tenant_1', identity: 'conv-c', activeTopicId: null });
      const topic = await repos.topics.create({ conversationId: conv.id, owner, tenant: 'tenant_1', title: 'T', kind: 'main' });

      const startResult = await repos.runs.recordRunLifecycleStart({
        run: { topicId: topic.id, owner, tenant: 'tenant_1', workKind: 'feature', currentStep: 'intake', terminal: false },
        runStep: { phase: null, step: 'intake', role: 'none', startedAt: new Date().toISOString(), endedAt: null, durationMs: null }
      });

      asInternalSqliteDatabase(database).client
        .prepare(`CREATE TRIGGER abort_run_steps_insert BEFORE INSERT ON run_steps BEGIN SELECT RAISE(ABORT, 'blocked'); END`)
        .run();

      await expect(repos.runs.recordRunStepTransition({
        runId: startResult.run.id,
        currentStep: 'spec.author',
        terminal: false,
        runStep: { phase: 'spec', step: 'spec.author', role: 'none', startedAt: new Date().toISOString(), endedAt: null, durationMs: null }
      })).rejects.toThrow();

      asInternalSqliteDatabase(database).client
        .prepare(`DROP TRIGGER abort_run_steps_insert`)
        .run();

      const run = await repos.runs.findById(startResult.run.id);
      expect(run?.currentStep).toBe('intake');

      database.close();
    });
  });

  it('throws if run does not exist', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const database = createSqliteDatabase({ path: databasePath });
      await migrateSqliteDatabase(database);
      const repos = createDrizzleDomainRepositories(database);

      await expect(repos.runs.recordRunStepTransition({
        runId: 'run_nonexistent',
        currentStep: 'spec.author',
        terminal: false,
        runStep: { phase: 'spec', step: 'spec.author', role: 'none', startedAt: new Date().toISOString(), endedAt: null, durationMs: null }
      })).rejects.toThrow();

      database.close();
    });
  });
});
