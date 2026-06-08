import { describe, expect, it } from 'vitest';

import {
  asInternalSqliteDatabase,
  createDrizzleDomainRepositories,
  createSqliteDatabase,
  migrateSqliteDatabase,
  withTempDatabasePath
} from '../index.js';
import type { DrizzleDomainRepositories, SqliteDatabase } from '../index.js';

const owner = { id: 'user_1', kind: 'human', tenantId: 'tenant_1', displayName: 'Ada' } as const;
const tokens = { input: 10, output: 20, cacheRead: 0, cacheWrite: 1 };
const cost = { model: { provider: 'openai', model: 'gpt-4.1' }, usd: null, tokens };

async function withRepositories(
  run: (repos: DrizzleDomainRepositories, database: SqliteDatabase) => Promise<void>
): Promise<void> {
  await withTempDatabasePath(async (databasePath) => {
    const database = createSqliteDatabase({ path: databasePath });
    await migrateSqliteDatabase(database);
    try {
      await run(createDrizzleDomainRepositories(database), database);
    } finally {
      database.close();
    }
  });
}

describe('DrizzleDomainRepositories round-trip', () => {
  it('creates and reads a project with owner and tenant', async () => {
    await withRepositories(async (repos) => {
      const project = await repos.projects.create({
        owner,
        tenant: 'tenant_1',
        displayName: 'Test Project',
        repoUrl: 'https://github.com/test/repo',
        hostRepository: { provider: 'github', owner: 'test', name: 'repo' },
        workspaceRootOverride: null,
        issueTrackerSetting: null,
        codeHostSetting: null,
        credentialRefs: []
      });
      expect(project.id).toMatch(/^proj_/u);
      expect(project.owner.kind).toBe('human');
      expect(project.tenant).toBe('tenant_1');

      const found = await repos.projects.findById(project.id);
      expect(found?.displayName).toBe('Test Project');

      await expect(
        repos.projects.create({
          owner: { id: 'model_1', kind: 'model', tenantId: 'tenant_1', displayName: 'M' } as never,
          tenant: 'tenant_1',
          displayName: 'Bad',
          repoUrl: 'https://example.test',
          hostRepository: { provider: 'github', owner: 'test', name: 'repo' },
          workspaceRootOverride: null,
          issueTrackerSetting: null,
          codeHostSetting: null,
          credentialRefs: []
        })
      ).rejects.toThrow();
    });
  });

  it('creates conversation with null activeTopicId and sets it via setActiveTopic', async () => {
    await withRepositories(async (repos) => {
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
        identity: 'conv-1',
        activeTopicId: null
      });
      expect(conv.activeTopicId).toBeNull();

      const topic = await repos.topics.create({
        conversationId: conv.id,
        owner,
        tenant: 'tenant_1',
        title: 'Main work',
        kind: 'main'
      });

      const convAfterTopicCreate = await repos.conversations.findById(conv.id);
      expect(convAfterTopicCreate?.activeTopicId).toBeNull();

      const updated = await repos.conversations.setActiveTopic(conv.id, topic.id);
      expect(updated.activeTopicId).toBe(topic.id);

      await expect(repos.conversations.setActiveTopic(conv.id, '')).rejects.toThrow();

      const otherConv = await repos.conversations.create({
        projectId: project.id,
        owner,
        tenant: 'tenant_1',
        identity: 'conv-2',
        activeTopicId: null
      });
      const otherTopic = await repos.topics.create({
        conversationId: otherConv.id,
        owner,
        tenant: 'tenant_1',
        title: 'Other',
        kind: 'main'
      });
      await expect(repos.conversations.setActiveTopic(conv.id, otherTopic.id)).rejects.toThrow();
    });
  });

  it('rejects duplicate main topics but allows side topics', async () => {
    await withRepositories(async (repos) => {
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
      await repos.topics.create({ conversationId: conv.id, owner, tenant: 'tenant_1', title: 'Main', kind: 'main' });

      await expect(
        repos.topics.create({ conversationId: conv.id, owner, tenant: 'tenant_1', title: 'Dup', kind: 'main' })
      ).rejects.toThrow();

      const sideA = await repos.topics.create({
        conversationId: conv.id,
        owner,
        tenant: 'tenant_1',
        title: 'Side A',
        kind: 'side'
      });
      const sideB = await repos.topics.create({
        conversationId: conv.id,
        owner,
        tenant: 'tenant_1',
        title: 'Side B',
        kind: 'side'
      });
      expect(sideA.kind).toBe('side');
      expect(sideB.kind).toBe('side');

      const allTopics = await repos.topics.listByConversation(conv.id);
      expect(allTopics).toHaveLength(3);
    });
  });

  it('creates messages and runs round-trip with parent list methods', async () => {
    await withRepositories(async (repos) => {
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

      const msg1 = await repos.messages.create({
        topicId: topic.id,
        owner,
        tenant: 'tenant_1',
        author: owner,
        direction: 'inbound',
        body: 'Hello'
      });
      const msg2 = await repos.messages.create({
        topicId: topic.id,
        owner,
        tenant: 'tenant_1',
        author: { id: 'model_1', kind: 'model', tenantId: 'tenant_1', displayName: 'M' },
        direction: 'outbound',
        body: 'Reply'
      });

      const msgs = await repos.messages.listByTopic(topic.id);
      expect(msgs).toHaveLength(2);
      const ids = msgs.map((m) => m.id).sort();
      expect(ids).toEqual([msg1.id, msg2.id].sort());

      // Gap 1: findById assertions for conversation, topic, and message
      const foundConv = await repos.conversations.findById(conv.id);
      expect(foundConv?.projectId).toBe(project.id);
      expect(foundConv?.identity).toBe('conv-c');
      expect(foundConv?.activeTopicId).toBeNull();

      const foundTopic = await repos.topics.findById(topic.id);
      expect(foundTopic?.conversationId).toBe(conv.id);
      expect(foundTopic?.title).toBe('T');
      expect(foundTopic?.kind).toBe('main');

      const foundMsg = await repos.messages.findById(msg1.id);
      expect(foundMsg?.topicId).toBe(topic.id);
      expect(foundMsg?.direction).toBe('inbound');
      expect(foundMsg?.body).toBe('Hello');

      const run = await repos.runs.create({
        topicId: topic.id,
        owner,
        tenant: 'tenant_1',
        workKind: 'feature',
        currentStep: 'spec.author',
        terminal: false,
        trackedIssue: { number: 11, title: 'Persistence', state: 'open', url: 'https://example.test/issues/11' },
        testingGuideResult: { status: 'not_run' }
      });
      expect(run.trackedIssue?.number).toBe(11);
      expect(run.testingGuideResult?.status).toBe('not_run');

      const foundRun = await repos.runs.findById(run.id);
      expect(foundRun?.currentStep).toBe('spec.author');
      expect(foundRun?.terminal).toBe(false);

      const runs = await repos.runs.listByTopic(topic.id);
      expect(runs).toHaveLength(1);
    });
  });

  it('creates run-owned records and reads them back', async () => {
    await withRepositories(async (repos) => {
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
      const run = await repos.runs.create({
        topicId: topic.id,
        owner,
        tenant: 'tenant_1',
        workKind: 'feature',
        currentStep: 'impl.build',
        terminal: false
      });

      // Gap 2: owner and tenant verified on readback for run
      const foundRun = await repos.runs.findById(run.id);
      expect(foundRun?.owner.kind).toBe('human');
      expect(foundRun?.tenant).toBe('tenant_1');

      const artifact = await repos.artifacts.create({
        runId: run.id,
        owner,
        tenant: 'tenant_1',
        kind: 'feature_spec',
        canonicalRecord: 'file',
        location: 'context-human/specs/feature.md',
        cachedStatus: 'approved',
        linkedIssue: { number: 11, title: 'Persistence', state: 'open', url: 'https://example.test/issues/11' },
        publicationRefs: ['pub_dummy']
      });
      expect((await repos.artifacts.findById(artifact.id))?.linkedIssue?.number).toBe(11);
      expect(await repos.artifacts.listByRun(run.id)).toHaveLength(1);

      // Gap 2: owner and tenant verified on readback for artifact
      const foundArtifact = await repos.artifacts.findById(artifact.id);
      expect(foundArtifact?.owner.id).toBe('user_1');
      expect(foundArtifact?.tenant).toBe('tenant_1');

      const fb = await repos.feedback.create({
        runId: run.id,
        owner,
        tenant: 'tenant_1',
        target: 'artifact',
        status: 'open',
        title: 'Issue',
        body: 'Needs detail.',
        anchor: { kind: 'artifact', artifactId: artifact.id },
        thread: [{ id: 'thread_1', author: owner, body: 'Needs detail.', createdAt: '2026-06-08T00:00:00.000Z' }]
      });
      expect((await repos.feedback.findById(fb.id))?.anchor?.kind).toBe('artifact');
      expect(await repos.feedback.listByRun(run.id)).toHaveLength(1);

      const pub = await repos.publications.create({
        runId: run.id,
        owner,
        tenant: 'tenant_1',
        provider: 'github',
        url: 'https://example.test/pub/1',
        label: 'Spec',
        frontedResource: { kind: 'artifact', id: artifact.id }
      });
      expect((await repos.publications.findById(pub.id))?.frontedResource.kind).toBe('artifact');

      const pr = await repos.pullRequests.create({
        runId: run.id,
        owner,
        tenant: 'tenant_1',
        provider: 'github',
        number: 12,
        url: 'https://example.test/pull/12',
        state: 'open',
        branch: 'feature/persistence'
      });
      expect(await repos.pullRequests.findByRun(run.id)).toMatchObject({ id: pr.id });
      expect(await repos.pullRequests.findByRun('run_nonexistent')).toBeNull();

      const step = await repos.runSteps.create({
        runId: run.id,
        phase: 'implementation',
        step: 'implementation.build',
        role: 'implementer',
        startedAt: '2026-06-08T00:00:00.000Z',
        endedAt: null,
        durationMs: null,
        occurrence: { index: 0, attempt: 1, key: 'impl-build-0' }
      });
      expect((await repos.runSteps.findById(step.id))?.occurrence.key).toBe('impl-build-0');

      const session = await repos.sessions.create({
        runId: run.id,
        phase: null,
        step: 'intake.classify',
        role: 'none',
        round: 0,
        model: { provider: 'openai', model: 'gpt-4.1' },
        inferenceSettings: { extra: { responseFormat: 'json' } },
        startedAt: '2026-06-08T00:00:00.000Z',
        endedAt: '2026-06-08T00:00:01.000Z',
        durationMs: 1000,
        tokens,
        usageAvailable: true,
        assistantTurnCount: 1,
        toolCallCount: 0,
        outcome: 'succeeded',
        cost
      });
      expect((await repos.sessions.findById(session.id))?.cost.usd).toBeNull();
      expect(await repos.sessions.listByRun(run.id)).toHaveLength(1);

      const testResult = await repos.testResults.create({
        runId: run.id,
        tester: owner,
        outcome: 'passed',
        evidence: { kind: 'external', summary: 'Manual pass.' },
        feedbackRefs: [fb.id]
      });
      expect((await repos.testResults.findById(testResult.id))?.outcome).toBe('passed');
      expect(await repos.testResults.listByRun(run.id)).toHaveLength(1);
    });
  });

  it('rejects session creation when tokens do not match cost.tokens', async () => {
    await withRepositories(async (repos) => {
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
      const run = await repos.runs.create({
        topicId: topic.id,
        owner,
        tenant: 'tenant_1',
        workKind: 'feature',
        currentStep: 'spec.author',
        terminal: false
      });

      await expect(
        repos.sessions.create({
          runId: run.id,
          phase: null,
          step: 'intake.classify',
          role: 'none',
          round: 0,
          model: { provider: 'openai', model: 'gpt-4.1' },
          inferenceSettings: {},
          startedAt: '2026-06-08T00:00:00.000Z',
          endedAt: '2026-06-08T00:00:01.000Z',
          durationMs: 1000,
          tokens,
          usageAvailable: true,
          assistantTurnCount: 1,
          toolCallCount: 0,
          outcome: 'succeeded',
          cost: { ...cost, tokens: { ...tokens, output: 999 } }
        })
      ).rejects.toThrow();
    });
  });

  it('rejects corrupted stored JSON when reading an artifact', async () => {
    await withRepositories(async (repos, database) => {
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
      const run = await repos.runs.create({
        topicId: topic.id,
        owner,
        tenant: 'tenant_1',
        workKind: 'feature',
        currentStep: 'spec.author',
        terminal: false
      });
      const artifact = await repos.artifacts.create({
        runId: run.id,
        owner,
        tenant: 'tenant_1',
        kind: 'feature_spec',
        canonicalRecord: 'file',
        location: 'path/to/spec.md',
        cachedStatus: 'draft',
        publicationRefs: []
      });

      // Corrupt the mandatory owner_json so read must throw on schema parse.
      asInternalSqliteDatabase(database).client
        .prepare('UPDATE artifacts SET owner_json = ? WHERE id = ?')
        .run('{"not_valid_principal": true}', artifact.id);

      await expect(repos.artifacts.findById(artifact.id)).rejects.toThrow();
    });
  });

  it('stores a conversation with a channel reference and reads it back', async () => {
    await withRepositories(async (repos) => {
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

      // Gap 3: channel reference round-trip
      const convWithChannel = await repos.conversations.create({
        projectId: project.id,
        owner,
        tenant: 'tenant_1',
        identity: 'conv-channel',
        channel: { provider: 'slack', channelId: 'C1', threadId: 'T1' },
        activeTopicId: null
      });
      const foundConv = await repos.conversations.findById(convWithChannel.id);
      expect(foundConv?.channel?.provider).toBe('slack');
      expect(foundConv?.channel?.channelId).toBe('C1');
      expect(foundConv?.channel?.threadId).toBe('T1');
    });
  });

  it('accepts an extensible currentStep string and reads it back', async () => {
    await withRepositories(async (repos) => {
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
      // Use a separate topic so a second run doesn't violate the one-active-run constraint on
      // the topic used in other tests.
      const topic = await repos.topics.create({
        conversationId: conv.id,
        owner,
        tenant: 'tenant_1',
        title: 'Custom step topic',
        kind: 'side'
      });

      // Gap 5: extensible currentStep — a value that is not a predefined step enum member
      const customRun = await repos.runs.create({
        topicId: topic.id,
        owner,
        tenant: 'tenant_1',
        workKind: 'custom_workflow',
        currentStep: 'my-custom-step-that-is-not-predefined',
        terminal: false
      });
      expect(customRun.currentStep).toBe('my-custom-step-that-is-not-predefined');

      const foundCustomRun = await repos.runs.findById(customRun.id);
      expect(foundCustomRun?.currentStep).toBe('my-custom-step-that-is-not-predefined');
    });
  });

  it('rejects a second PR for the same run', async () => {
    await withRepositories(async (repos) => {
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
      const run = await repos.runs.create({
        topicId: topic.id,
        owner,
        tenant: 'tenant_1',
        workKind: 'feature',
        currentStep: 'spec.author',
        terminal: false
      });

      await repos.pullRequests.create({
        runId: run.id,
        owner,
        tenant: 'tenant_1',
        provider: 'github',
        number: 1,
        url: 'https://example.test/pull/1',
        state: 'open',
        branch: 'feat'
      });
      await expect(
        repos.pullRequests.create({
          runId: run.id,
          owner,
          tenant: 'tenant_1',
          provider: 'github',
          number: 2,
          url: 'https://example.test/pull/2',
          state: 'open',
          branch: 'feat2'
        })
      ).rejects.toThrow();
    });
  });
});
