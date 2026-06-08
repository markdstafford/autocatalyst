import { describe, expect, it } from 'vitest';

import {
  createDrizzleDomainRepositories,
  createSqliteDatabase,
  migrateSqliteDatabase,
  withTempDatabasePath
} from '../index.js';

const owner = { id: 'user_1', kind: 'human', tenantId: 'tenant_1', displayName: 'Ada' } as const;

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
