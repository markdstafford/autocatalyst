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
      const legacyCheckpoint = { providerModelMemory: { reviewer: { providerKind: 'openai', adapterId: 'openai-agents-sdk', state: { previousResponseId: 'legacy_response' } } } };
      await repos.runSteps.updateCheckpoint({ runStepId: startResult.runStep.id, runId, tenant: 'tenant_1', checkpointResult: legacyCheckpoint });

      const t1 = await repos.runs.recordRunStepTransition({
        expectedStep: 'intake',
        runId,
        currentStep: 'spec.author',
        terminal: false,
        runStep: { phase: 'spec', step: 'spec.author', role: 'none', startedAt: new Date().toISOString(), endedAt: null, durationMs: null }
      });
      expect(t1.run.currentStep).toBe('spec.author');
      expect(t1.run.terminal).toBe(false);
      expect(t1.runStep.occurrence.index).toBe(1);
      expect(t1.runStep.occurrence.attempt).toBe(1);
      expect(t1.runStep.checkpointResult).toBeNull();
      expect((await repos.runSteps.findById(startResult.runStep.id))?.checkpointResult).toEqual(legacyCheckpoint);

      const t2 = await repos.runs.recordRunStepTransition({
        expectedStep: 'spec.author',
        runId,
        currentStep: 'spec.author',
        terminal: false,
        sourceRunStepId: t1.runStep.id,
        checkpointResult: { result: 'closed' },
        destinationCheckpointResult: { resume: 'opened' },
        runStep: { phase: 'spec', step: 'spec.author', role: 'none', startedAt: new Date().toISOString(), endedAt: null, durationMs: null }
      });
      expect(t2.runStep.occurrence.index).toBe(2);
      expect(t2.runStep.occurrence.attempt).toBe(2);
      expect(t2.runStep.checkpointResult).toEqual({ resume: 'opened' });
      expect((await repos.runSteps.findById(t2.runStep.id))?.checkpointResult).toEqual({ resume: 'opened' });
      expect(await repos.runSteps.findById(t1.runStep.id)).toMatchObject({
        endedAt: t2.runStep.startedAt,
        checkpointResult: { result: 'closed' }
      });

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
        expectedStep: 'intake',
        runId: startResult.run.id,
        currentStep: 'spec.author',
        terminal: false,
        sourceRunStepId: startResult.runStep.id,
        checkpointResult: { result: 'closed' },
        destinationCheckpointResult: { resume: 'opened' },
        runStep: { phase: 'spec', step: 'spec.author', role: 'none', startedAt: new Date().toISOString(), endedAt: null, durationMs: null }
      })).rejects.toThrow();

      asInternalSqliteDatabase(database).client
        .prepare(`DROP TRIGGER abort_run_steps_insert`)
        .run();

      const run = await repos.runs.findById(startResult.run.id);
      expect(run?.currentStep).toBe('intake');
      expect(await repos.runSteps.findById(startResult.runStep.id)).toMatchObject({
        endedAt: null,
        checkpointResult: null
      });

      database.close();
    });
  });

  it('throws if run does not exist', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const database = createSqliteDatabase({ path: databasePath });
      await migrateSqliteDatabase(database);
      const repos = createDrizzleDomainRepositories(database);

      await expect(repos.runs.recordRunStepTransition({
        expectedStep: 'intake',
        runId: 'run_nonexistent',
        currentStep: 'spec.author',
        terminal: false,
        runStep: { phase: 'spec', step: 'spec.author', role: 'none', startedAt: new Date().toISOString(), endedAt: null, durationMs: null }
      })).rejects.toThrow();

      database.close();
    });
  });

  it('round-trips failureReason on lifecycle transition result', async () => {
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
        run: { topicId: topic.id, owner, tenant: 'tenant_1', workKind: 'feature', currentStep: 'spec.author', terminal: false },
        runStep: { phase: 'spec', step: 'spec.author', role: 'none', startedAt: new Date().toISOString(), endedAt: null, durationMs: null }
      });

      const transitioned = await repos.runs.recordRunStepTransition({
        expectedStep: 'spec.author',
        runId: startResult.run.id,
        currentStep: 'failed',
        terminal: true,
        failureReason: 'provider_auth_failed',
        runStep: { phase: null, step: 'failed', role: 'none', startedAt: new Date().toISOString(), endedAt: null, durationMs: null }
      });
      expect(transitioned.run.failureReason).toBe('provider_auth_failed');

      database.close();
    });
  });
});

it('guards both the expected step and occurrence before closing an abandoned input pause', async () => {
  await withTempDatabasePath(async (databasePath) => {
    const database = createSqliteDatabase({ path: databasePath });
    await migrateSqliteDatabase(database);
    const repos = createDrizzleDomainRepositories(database);
    try {
      const tenant = owner.tenantId;
      const project = await repos.projects.create({
        owner, tenant, displayName: 'P', repoUrl: 'https://example.test',
        hostRepository: { provider: 'github', owner: 'test', name: 'repo' },
        workspaceRootOverride: null, issueTrackerSetting: null, codeHostSetting: null, credentialRefs: []
      });
      const conversation = await repos.conversations.create({ projectId: project.id, owner, tenant, identity: 'guard', activeTopicId: null });
      const topic = await repos.topics.create({ conversationId: conversation.id, owner, tenant, title: 'T', kind: 'main' });
      const startedAt = '2026-11-27T12:00:00.000Z';
      const pause = 'implementation.awaiting_input';
      const start = await repos.runs.recordRunLifecycleStart({
        run: { topicId: topic.id, owner, tenant, workKind: 'feature', currentStep: pause, terminal: false },
        runStep: { phase: 'implementation', step: pause, role: 'none', startedAt, endedAt: null, durationMs: null }
      });
      const runId = start.run.id;
      const checkpoint = { pause: { question: 'Use the public API?' }, other: 'keep' };
      await repos.runSteps.updateCheckpoint({ runId, tenant, runStepId: start.runStep.id, checkpointResult: checkpoint });
      const transition = {
        runId, expectedStep: pause, currentStep: 'spec.human_review', terminal: false, abandonInput: true,
        sourceRunStepId: start.runStep.id,
        runStep: { phase: 'spec', step: 'spec.human_review', role: 'none', startedAt, endedAt: null, durationMs: null }
      } as const;

      await expect(repos.runs.recordRunStepTransition({ ...transition, expectedStep: 'implementation.build' }))
        .rejects.toMatchObject({ code: 'source_step_mismatch' });
      await expect(repos.runs.recordRunStepTransition({ ...transition, sourceRunStepId: 'old_occurrence' }))
        .rejects.toMatchObject({ code: 'source_occurrence_mismatch' });
      expect(await repos.runs.findById(runId)).toEqual(start.run);
      expect(await repos.runSteps.listByRun(runId)).toEqual([{ ...start.runStep, checkpointResult: checkpoint }]);

      const move = await repos.runs.recordRunStepTransition(transition);
      expect(move.runStep.checkpointResult).toBeNull();
      expect(await repos.runSteps.findById(start.runStep.id)).toMatchObject({
        endedAt: startedAt, checkpointResult: { ...checkpoint, abandonedBySetStep: true }
      });
      await repos.runs.recordRunStepTransition({
        runId, expectedStep: 'spec.human_review', currentStep: 'canceled', terminal: true,
        runStep: { phase: null, step: 'canceled', role: 'none', startedAt, endedAt: null, durationMs: null }
      });
      await expect(repos.runs.recordRunStepTransition({ ...transition, expectedStep: 'canceled' }))
        .rejects.toMatchObject({ code: 'terminal_run' });
      expect(await repos.runSteps.listByRun(runId)).toHaveLength(3);
    } finally {
      database.close();
    }
  });
});
