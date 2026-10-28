import { describe, expect, it } from 'vitest';

import { ActiveRunConflictPersistenceError } from '../active-run-conflict.js';
import {
  createDrizzleDomainRepositories,
  createSqliteDatabase,
  migrateSqliteDatabase,
  withTempDatabasePath
} from '../index.js';

const owner = { id: 'user_1', kind: 'human', tenantId: 'tenant_1', displayName: 'Ada' } as const;

async function setupFailedRun(repos: ReturnType<typeof createDrizzleDomainRepositories>) {
  const project = await repos.projects.create({
    owner, tenant: 'tenant_1', displayName: 'P', repoUrl: 'https://example.test',
    hostRepository: { provider: 'github', owner: 'test', name: 'repo' },
    workspaceRootOverride: null, issueTrackerSetting: null, codeHostSetting: null, credentialRefs: []
  });
  const conv = await repos.conversations.create({ projectId: project.id, owner, tenant: 'tenant_1', identity: 'conv-c', activeTopicId: null });
  const topic = await repos.topics.create({ conversationId: conv.id, owner, tenant: 'tenant_1', title: 'T', kind: 'main' });

  const start = await repos.runs.recordRunLifecycleStart({
    run: { topicId: topic.id, owner, tenant: 'tenant_1', workKind: 'feature', currentStep: 'implementation.build', terminal: false },
    runStep: { phase: 'implementation', step: 'implementation.build', role: 'implementer', startedAt: new Date().toISOString(), endedAt: null, durationMs: null }
  });
  const runId = start.run.id;

  // Transition the run to the terminal failed state (closing the build step occurrence).
  await repos.runs.recordRunStepTransition({
    runId,
    currentStep: 'failed',
    terminal: true,
    failureReason: 'provider_auth_failed',
    sourceRunStepId: start.runStep.id,
    runStep: { phase: null, step: 'failed', role: 'none', startedAt: new Date().toISOString(), endedAt: null, durationMs: null }
  });

  return { runId, topicId: topic.id, buildStepId: start.runStep.id };
}

describe('recoverFailedRun', () => {
  it('reopens a failed run at the re-dispatch step, clears terminal/failureReason, and preserves prior rows', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const database = createSqliteDatabase({ path: databasePath });
      await migrateSqliteDatabase(database);
      const repos = createDrizzleDomainRepositories(database);
      const { runId } = await setupFailedRun(repos);

      const before = await repos.runSteps.listByRun(runId);
      expect(before).toHaveLength(2); // build + failed

      const result = await repos.runs.recoverFailedRun!({
        runId,
        reDispatchStep: 'implementation.build',
        runStep: { phase: 'implementation', step: 'implementation.build', role: 'implementer', startedAt: new Date().toISOString(), endedAt: null, durationMs: null }
      });

      expect(result.run.currentStep).toBe('implementation.build');
      expect(result.run.terminal).toBe(false);
      expect(result.run.failureReason).toBeUndefined();
      expect(result.runStep.step).toBe('implementation.build');
      expect(result.runStep.endedAt).toBeNull();

      // Earlier rows (including the terminal failed row) remain listable.
      const after = await repos.runSteps.listByRun(runId);
      expect(after).toHaveLength(3);
      expect(after.some((s) => s.step === 'failed')).toBe(true);

      const reloaded = await repos.runs.findById(runId);
      expect(reloaded?.terminal).toBe(false);
      expect(reloaded?.failureReason).toBeUndefined();

      database.close();
    });
  });

  it('throws when the run is not a recoverable failed run', async () => {
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
      const start = await repos.runs.recordRunLifecycleStart({
        run: { topicId: topic.id, owner, tenant: 'tenant_1', workKind: 'feature', currentStep: 'implementation.build', terminal: false },
        runStep: { phase: 'implementation', step: 'implementation.build', role: 'implementer', startedAt: new Date().toISOString(), endedAt: null, durationMs: null }
      });

      await expect(repos.runs.recoverFailedRun!({
        runId: start.run.id,
        reDispatchStep: 'implementation.build',
        runStep: { phase: 'implementation', step: 'implementation.build', role: 'implementer', startedAt: new Date().toISOString(), endedAt: null, durationMs: null }
      })).rejects.toThrow();

      database.close();
    });
  });

  it('maps a concurrent active run on the topic to an active-run conflict', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const database = createSqliteDatabase({ path: databasePath });
      await migrateSqliteDatabase(database);
      const repos = createDrizzleDomainRepositories(database);
      const { runId, topicId } = await setupFailedRun(repos);

      // A second, active run now exists on the same topic.
      await repos.runs.recordRunLifecycleStart({
        run: { topicId, owner, tenant: 'tenant_1', workKind: 'feature', currentStep: 'intake', terminal: false },
        runStep: { phase: null, step: 'intake', role: 'none', startedAt: new Date().toISOString(), endedAt: null, durationMs: null }
      });

      await expect(repos.runs.recoverFailedRun!({
        runId,
        reDispatchStep: 'implementation.build',
        runStep: { phase: 'implementation', step: 'implementation.build', role: 'implementer', startedAt: new Date().toISOString(), endedAt: null, durationMs: null }
      })).rejects.toBeInstanceOf(ActiveRunConflictPersistenceError);

      // The failed run is left unchanged.
      const reloaded = await repos.runs.findById(runId);
      expect(reloaded?.terminal).toBe(true);
      expect(reloaded?.currentStep).toBe('failed');

      database.close();
    });
  });
});
