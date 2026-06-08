import { describe, expect, it } from 'vitest';

import { applyRunDirective, startRunLifecycle } from '@autocatalyst/core';

import {
  createDrizzleDomainRepositories,
  createSqliteDatabase,
  migrateSqliteDatabase,
  withTempDatabasePath
} from '../index.js';

const owner = { id: 'user_1', kind: 'human' as const, tenantId: 'tenant_1', displayName: 'Ada' };

async function createTopicFixture(repos: ReturnType<typeof createDrizzleDomainRepositories>) {
  const project = await repos.projects.create({
    owner, tenant: 'tenant_1', displayName: 'P', repoUrl: 'https://example.test',
    hostRepository: { provider: 'github', owner: 'test', name: 'repo' },
    workspaceRootOverride: null, issueTrackerSetting: null, codeHostSetting: null, credentialRefs: []
  });
  const conv = await repos.conversations.create({
    projectId: project.id, owner, tenant: 'tenant_1', identity: 'conv-c', activeTopicId: null
  });
  return repos.topics.create({
    conversationId: conv.id, owner, tenant: 'tenant_1', title: 'T', kind: 'main'
  });
}

describe('feature run lifecycle integration', () => {
  it('drives a feature run from intake to done with advance and revise', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const database = createSqliteDatabase({ path: databasePath });
      await migrateSqliteDatabase(database);
      const repos = createDrizzleDomainRepositories(database);

      const topic = await createTopicFixture(repos);

      let tickMs = 0;
      const clock = () => new Date(Date.UTC(2024, 0, 1, 0, 0, 0, tickMs++)).toISOString();

      let state = await startRunLifecycle({
        runs: repos.runs,
        run: { topicId: topic.id, owner, tenant: 'tenant_1', workKind: 'feature' },
        clock
      });

      expect(state.run.currentStep).toBe('intake');
      expect(state.run.terminal).toBe(false);

      const directives: Array<['advance' | 'revise', string]> = [
        ['advance', 'spec.author'],
        ['advance', 'spec.human_review'],
        ['advance', 'implementation.plan'],
        ['advance', 'implementation.build'],
        ['advance', 'implementation.human_review'],
        ['revise', 'implementation.build'],
        ['advance', 'implementation.human_review'],
        ['advance', 'docs.update'],
        ['advance', 'docs.human_review'],
        ['advance', 'pr.finalize'],
        ['advance', 'pr.open'],
        ['advance', 'pr.human_review'],
        ['advance', 'done']
      ];

      for (const [directive, expectedStep] of directives) {
        state = await applyRunDirective({
          runs: repos.runs,
          runId: state.run.id,
          directive,
          clock
        });
        expect(state.run.currentStep).toBe(expectedStep);
      }

      expect(state.run.terminal).toBe(true);

      const stepRows = await repos.runSteps.listByRun(state.run.id);

      const expectedSteps = [
        'intake',
        'spec.author',
        'spec.human_review',
        'implementation.plan',
        'implementation.build',
        'implementation.human_review',
        'implementation.build',
        'implementation.human_review',
        'docs.update',
        'docs.human_review',
        'pr.finalize',
        'pr.open',
        'pr.human_review',
        'done'
      ];

      expect(stepRows.map((s) => s.step)).toEqual(expectedSteps);
      expect(stepRows.map((s) => s.occurrence.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);

      const secondBuildVisit = stepRows.find((s) => s.step === 'implementation.build' && s.occurrence.index === 6);
      expect(secondBuildVisit?.occurrence.attempt).toBe(2);

      expect(stepRows.every((s) => s.role === 'none')).toBe(true);

      const specAuthorStep = stepRows.find((s) => s.step === 'spec.author');
      expect(specAuthorStep?.phase).toBe('spec');

      database.close();
    });
  });

  it('human gates hold until another directive is applied', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const database = createSqliteDatabase({ path: databasePath });
      await migrateSqliteDatabase(database);
      const repos = createDrizzleDomainRepositories(database);

      const topic = await createTopicFixture(repos);

      let state = await startRunLifecycle({
        runs: repos.runs,
        run: { topicId: topic.id, owner, tenant: 'tenant_1', workKind: 'feature' }
      });

      state = await applyRunDirective({ runs: repos.runs, runId: state.run.id, directive: 'advance' });
      state = await applyRunDirective({ runs: repos.runs, runId: state.run.id, directive: 'advance' });

      expect(state.run.currentStep).toBe('spec.human_review');

      const runAfterGate = await repos.runs.findById(state.run.id);
      expect(runAfterGate?.currentStep).toBe('spec.human_review');
      expect(runAfterGate?.terminal).toBe(false);

      state = await applyRunDirective({ runs: repos.runs, runId: state.run.id, directive: 'advance' });
      expect(state.run.currentStep).toBe('implementation.plan');

      database.close();
    });
  });

  it('allows a new run after a previous run reaches done (partial index)', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const database = createSqliteDatabase({ path: databasePath });
      await migrateSqliteDatabase(database);
      const repos = createDrizzleDomainRepositories(database);

      const topic = await createTopicFixture(repos);

      const featureStart = await startRunLifecycle({
        runs: repos.runs,
        run: { topicId: topic.id, owner, tenant: 'tenant_1', workKind: 'feature' }
      });

      let state = featureStart;
      // 11 advances: intake→done without any revise
      const advanceCount = 11;
      for (let i = 0; i < advanceCount; i++) {
        state = await applyRunDirective({ runs: repos.runs, runId: state.run.id, directive: 'advance' });
      }
      expect(state.run.currentStep).toBe('done');
      expect(state.run.terminal).toBe(true);

      const questionStart = await startRunLifecycle({
        runs: repos.runs,
        run: { topicId: topic.id, owner, tenant: 'tenant_1', workKind: 'question' }
      });
      expect(questionStart.run.currentStep).toBe('intake');
      expect(questionStart.run.terminal).toBe(false);

      database.close();
    });
  });
});
