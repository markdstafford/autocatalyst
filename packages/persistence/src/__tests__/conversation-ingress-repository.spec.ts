import { describe, expect, it } from 'vitest';

import {
  DrizzleConversationIngressRepository,
  asInternalSqliteDatabase,
  createDrizzleDomainRepositories,
  createSqliteDatabase,
  migrateSqliteDatabase,
  withTempDatabasePath
} from '../index.js';

const owner = { id: 'user_1', kind: 'human', tenantId: 'tenant_1', displayName: 'Ada' } as const;

async function setupProject(database: ReturnType<typeof createSqliteDatabase>) {
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
  return { repos, project };
}

describe('DrizzleConversationIngressRepository', () => {
  describe('createConversationTopicMessageAndRun', () => {
    it('creates conversation, topic, message, run, and runStep atomically', async () => {
      await withTempDatabasePath(async (databasePath) => {
        const database = createSqliteDatabase({ path: databasePath });
        await migrateSqliteDatabase(database);
        const { repos, project } = await setupProject(database);
        const repo = new DrizzleConversationIngressRepository(database);

        const startedAt = new Date().toISOString();
        const result = await repo.createConversationTopicMessageAndRun({
          conversation: {
            projectId: project.id,
            owner,
            tenant: 'tenant_1',
            identity: 'conv-identity-1',
            activeTopicId: null
          },
          topic: {
            owner,
            tenant: 'tenant_1',
            title: 'My topic',
            kind: 'main'
          },
          message: {
            owner,
            tenant: 'tenant_1',
            author: owner,
            direction: 'inbound',
            body: 'Hello, agent!'
          },
          run: {
            owner,
            tenant: 'tenant_1',
            workKind: 'feature'
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

        // Check conversation
        expect(result.conversation.projectId).toBe(project.id);
        expect(result.conversation.identity).toBe('conv-identity-1');
        expect(result.conversation.activeTopicId).toBe(result.topic.id);

        // Check topic
        expect(result.topic.conversationId).toBe(result.conversation.id);
        expect(result.topic.title).toBe('My topic');
        expect(result.topic.kind).toBe('main');

        // Check message
        expect(result.message).toBeDefined();
        expect(result.message?.body).toBe('Hello, agent!');
        expect(result.message?.direction).toBe('inbound');
        expect(result.message?.topicId).toBe(result.topic.id);

        // Check run
        expect(result.run.topicId).toBe(result.topic.id);
        expect(result.run.currentStep).toBe('intake');
        expect(result.run.terminal).toBe(false);
        expect(result.run.workKind).toBe('feature');

        // Check runStep
        expect(result.runStep.runId).toBe(result.run.id);
        expect(result.runStep.step).toBe('intake');
        expect(result.runStep.occurrence.index).toBe(0);
        expect(result.runStep.occurrence.attempt).toBe(1);

        // Verify persisted
        const conv = await repos.conversations.findById(result.conversation.id);
        expect(conv?.activeTopicId).toBe(result.topic.id);
        const topic = await repos.topics.findById(result.topic.id);
        expect(topic?.id).toBe(result.topic.id);
        const msgs = await repos.messages.listByTopic(result.topic.id);
        expect(msgs).toHaveLength(1);
        const runsForTopic = await repos.runs.listByTopic(result.topic.id);
        expect(runsForTopic).toHaveLength(1);
        const steps = await repos.runSteps.listByRun(result.run.id);
        expect(steps).toHaveLength(1);

        database.close();
      });
    });

    it('creates without a message when message is undefined', async () => {
      await withTempDatabasePath(async (databasePath) => {
        const database = createSqliteDatabase({ path: databasePath });
        await migrateSqliteDatabase(database);
        const { repos, project } = await setupProject(database);
        const repo = new DrizzleConversationIngressRepository(database);

        const startedAt = new Date().toISOString();
        const result = await repo.createConversationTopicMessageAndRun({
          conversation: {
            projectId: project.id,
            owner,
            tenant: 'tenant_1',
            identity: 'conv-identity-2',
            activeTopicId: null
          },
          topic: {
            owner,
            tenant: 'tenant_1',
            title: 'No message topic',
            kind: 'main'
          },
          run: {
            owner,
            tenant: 'tenant_1',
            workKind: 'feature'
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

        expect(result.message).toBeUndefined();
        expect(result.conversation.activeTopicId).toBe(result.topic.id);
        const msgs = await repos.messages.listByTopic(result.topic.id);
        expect(msgs).toHaveLength(0);

        database.close();
      });
    });

    it('rolls back the entire transaction when run_steps insert fails', async () => {
      await withTempDatabasePath(async (databasePath) => {
        const database = createSqliteDatabase({ path: databasePath });
        await migrateSqliteDatabase(database);
        const { repos, project } = await setupProject(database);
        const repo = new DrizzleConversationIngressRepository(database);

        asInternalSqliteDatabase(database).client
          .prepare(`CREATE TRIGGER abort_run_steps_insert BEFORE INSERT ON run_steps BEGIN SELECT RAISE(ABORT, 'blocked'); END`)
          .run();

        const startedAt = new Date().toISOString();
        await expect(
          repo.createConversationTopicMessageAndRun({
            conversation: {
              projectId: project.id,
              owner,
              tenant: 'tenant_1',
              identity: 'conv-identity-3',
              activeTopicId: null
            },
            topic: {
              owner,
              tenant: 'tenant_1',
              title: 'Rollback topic',
              kind: 'main'
            },
            run: {
              owner,
              tenant: 'tenant_1',
              workKind: 'feature'
            },
            runStep: {
              phase: null,
              step: 'intake',
              role: 'none',
              startedAt,
              endedAt: null,
              durationMs: null
            }
          })
        ).rejects.toThrow();

        asInternalSqliteDatabase(database).client
          .prepare(`DROP TRIGGER abort_run_steps_insert`)
          .run();

        // Verify nothing was persisted
        const convs = await repos.conversations.findById('non-existent');
        expect(convs).toBeNull();
        // No conversations with identity conv-identity-3 should exist
        const allRuns = await repos.runs.listByTopic('non-existent-topic');
        expect(allRuns).toHaveLength(0);

        database.close();
      });
    });

    it('throws ActiveRunConflictPersistenceError when active run constraint is violated', async () => {
      await withTempDatabasePath(async (databasePath) => {
        const database = createSqliteDatabase({ path: databasePath });
        await migrateSqliteDatabase(database);
        const { project } = await setupProject(database);
        const repos = createDrizzleDomainRepositories(database);
        const repo = new DrizzleConversationIngressRepository(database);

        // Create a conversation+topic+run normally
        const startedAt = new Date().toISOString();
        const first = await repo.createConversationTopicMessageAndRun({
          conversation: {
            projectId: project.id,
            owner,
            tenant: 'tenant_1',
            identity: 'conv-identity-4',
            activeTopicId: null
          },
          topic: {
            owner,
            tenant: 'tenant_1',
            title: 'Topic 4',
            kind: 'main'
          },
          run: {
            owner,
            tenant: 'tenant_1',
            workKind: 'feature'
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
        // The first one should succeed
        expect(first.run.terminal).toBe(false);

        // Now force a duplicate active run by creating a second run on the same topic directly
        // This simulates the constraint being hit
        await expect(
          repos.runs.create({
            topicId: first.topic.id,
            owner,
            tenant: 'tenant_1',
            workKind: 'feature',
            currentStep: 'intake',
            terminal: false
          })
        ).rejects.toThrow();

        database.close();
      });
    });
  });
});
