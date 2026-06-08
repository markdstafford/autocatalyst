import { describe, expect, it } from 'vitest';

import {
  createDrizzleDomainRepositories,
  createSqliteDatabase,
  migrateSqliteDatabase,
  withTempDatabasePath
} from '../index.js';
import type { DrizzleDomainRepositories } from '../index.js';

const owner = { id: 'user_1', kind: 'human', tenantId: 'tenant_1', displayName: 'Ada' } as const;
const tokens = { input: 10, output: 20, cacheRead: 0, cacheWrite: 1 };
const cost = { model: { provider: 'openai', model: 'gpt-4.1' }, usd: null, tokens };

async function withRepositories(run: (repos: DrizzleDomainRepositories) => Promise<void>): Promise<void> {
  await withTempDatabasePath(async (databasePath) => {
    const database = createSqliteDatabase({ path: databasePath });
    await migrateSqliteDatabase(database);
    try {
      await run(createDrizzleDomainRepositories(database));
    } finally {
      database.close();
    }
  });
}

describe('domain repository parent existence enforcement', () => {
  it('conversation create fails when project does not exist', async () => {
    await withRepositories(async (repos) => {
      await expect(
        repos.conversations.create({
          projectId: 'nonexistent_id',
          owner,
          tenant: 'tenant_1',
          identity: 'orphan',
          activeTopicId: null
        })
      ).rejects.toThrow("Project 'nonexistent_id' does not exist.");
    });
  });

  it('topic create fails when conversation does not exist', async () => {
    await withRepositories(async (repos) => {
      await expect(
        repos.topics.create({
          conversationId: 'nonexistent_id',
          owner,
          tenant: 'tenant_1',
          title: 'Orphan',
          kind: 'main'
        })
      ).rejects.toThrow("Conversation 'nonexistent_id' does not exist.");
    });
  });

  it('message create fails when topic does not exist', async () => {
    await withRepositories(async (repos) => {
      await expect(
        repos.messages.create({
          topicId: 'nonexistent_id',
          owner,
          tenant: 'tenant_1',
          author: owner,
          direction: 'inbound',
          body: 'Hello'
        })
      ).rejects.toThrow("Topic 'nonexistent_id' does not exist.");
    });
  });

  it('run create fails when topic does not exist', async () => {
    await withRepositories(async (repos) => {
      await expect(
        repos.runs.create({
          topicId: 'nonexistent_id',
          owner,
          tenant: 'tenant_1',
          workKind: 'feature',
          currentStep: 'spec.author',
          terminal: false
        })
      ).rejects.toThrow("Topic 'nonexistent_id' does not exist.");
    });
  });

  it('artifact create fails when run does not exist', async () => {
    await withRepositories(async (repos) => {
      await expect(
        repos.artifacts.create({
          runId: 'nonexistent_id',
          owner,
          tenant: 'tenant_1',
          kind: 'feature_spec',
          canonicalRecord: 'file',
          location: 'context-human/specs/feature.md',
          cachedStatus: 'approved',
          publicationRefs: []
        })
      ).rejects.toThrow("Run 'nonexistent_id' does not exist.");
    });
  });

  it('feedback create fails when run does not exist', async () => {
    await withRepositories(async (repos) => {
      await expect(
        repos.feedback.create({
          runId: 'nonexistent_id',
          owner,
          tenant: 'tenant_1',
          target: 'artifact',
          status: 'open',
          title: 'Fix this',
          body: 'Details here',
          thread: [{ id: 'thread_1', author: owner, body: 'Details here', createdAt: '2026-06-08T00:00:00.000Z' }]
        })
      ).rejects.toThrow("Run 'nonexistent_id' does not exist.");
    });
  });

  it('publication create fails when run does not exist', async () => {
    await withRepositories(async (repos) => {
      await expect(
        repos.publications.create({
          runId: 'nonexistent_id',
          owner,
          tenant: 'tenant_1',
          provider: 'github',
          url: 'https://github.com/test/repo/pub/1',
          label: 'Spec',
          frontedResource: { kind: 'artifact', id: 'art_dummy' }
        })
      ).rejects.toThrow("Run 'nonexistent_id' does not exist.");
    });
  });

  it('pullRequest create fails when run does not exist', async () => {
    await withRepositories(async (repos) => {
      await expect(
        repos.pullRequests.create({
          runId: 'nonexistent_id',
          owner,
          tenant: 'tenant_1',
          provider: 'github',
          number: 42,
          url: 'https://github.com/test/repo/pull/42',
          state: 'open',
          branch: 'feature/test'
        })
      ).rejects.toThrow("Run 'nonexistent_id' does not exist.");
    });
  });

  it('runStep create fails when run does not exist', async () => {
    await withRepositories(async (repos) => {
      await expect(
        repos.runSteps.create({
          runId: 'nonexistent_id',
          phase: 'implementation',
          step: 'implementation.build',
          role: 'implementer',
          startedAt: '2026-06-08T00:00:00.000Z',
          endedAt: null,
          durationMs: null,
          occurrence: { index: 0, attempt: 1 }
        })
      ).rejects.toThrow("Run 'nonexistent_id' does not exist.");
    });
  });

  it('session create fails when run does not exist', async () => {
    await withRepositories(async (repos) => {
      await expect(
        repos.sessions.create({
          runId: 'nonexistent_id',
          phase: null,
          step: 'intake.classify',
          role: 'none',
          round: 0,
          model: { provider: 'openai', model: 'gpt-4.1' },
          inferenceSettings: {},
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
          durationMs: 100,
          tokens,
          usageAvailable: true,
          assistantTurnCount: 1,
          toolCallCount: 0,
          outcome: 'succeeded',
          cost
        })
      ).rejects.toThrow("Run 'nonexistent_id' does not exist.");
    });
  });

  it('testResult create fails when run does not exist', async () => {
    await withRepositories(async (repos) => {
      await expect(
        repos.testResults.create({
          runId: 'nonexistent_id',
          tester: owner,
          outcome: 'passed',
          feedbackRefs: []
        })
      ).rejects.toThrow("Run 'nonexistent_id' does not exist.");
    });
  });
});
