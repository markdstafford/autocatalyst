import { describe, expect, it } from 'vitest';

import { FeedbackConcurrentModificationError } from '@autocatalyst/core';

import {
  asInternalSqliteDatabase,
  createDrizzleDomainRepositories,
  createSqliteDatabase,
  defaultRunListLimit,
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

async function createProjectConversationAndTopic(
  repos: DrizzleDomainRepositories,
  input: { readonly tenant: string; readonly owner: typeof owner; readonly identity: string; readonly title: string }
) {
  const project = await repos.projects.create({
    owner: input.owner,
    tenant: input.tenant,
    displayName: `Project ${input.identity}`,
    repoUrl: 'https://example.test/repo',
    hostRepository: { provider: 'github', owner: 'example', name: `repo-${input.identity}` },
    workspaceRootOverride: null,
    issueTrackerSetting: null,
    codeHostSetting: null,
    credentialRefs: []
  });
  const conversation = await repos.conversations.create({
    projectId: project.id,
    owner: input.owner,
    tenant: input.tenant,
    identity: input.identity,
    activeTopicId: null
  });
  const topic = await repos.topics.create({
    conversationId: conversation.id,
    owner: input.owner,
    tenant: input.tenant,
    title: input.title,
    kind: 'main'
  });
  return { project, conversation, topic };
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

  it('reads legacy tracked issue JSON (no body/labels) with defaults body="" and labels=[]', async () => {
    await withRepositories(async (repos, database) => {
      const setup = await createProjectConversationAndTopic(repos, {
        tenant: 'tenant_1',
        owner,
        identity: 'legacy-tracked-issue',
        title: 'Legacy tracked issue topic'
      });
      const run = await repos.runs.create({
        topicId: setup.topic.id,
        owner,
        tenant: 'tenant_1',
        workKind: 'feature',
        currentStep: 'spec.author',
        terminal: false
      });

      // Overwrite tracked_issue_json with a legacy payload (no body, no labels). This
      // simulates a row written before the TrackedIssue contract was enriched.
      const legacyJson = JSON.stringify({
        number: 11,
        title: 'Legacy Issue',
        state: 'open',
        url: 'https://example.test/issues/11'
      });
      asInternalSqliteDatabase(database).client
        .prepare('UPDATE runs SET tracked_issue_json = ? WHERE id = ?')
        .run(legacyJson, run.id);

      const reread = await repos.runs.findById(run.id);
      expect(reread?.trackedIssue).toBeDefined();
      expect(reread?.trackedIssue?.number).toBe(11);
      expect(reread?.trackedIssue?.title).toBe('Legacy Issue');
      expect(reread?.trackedIssue?.state).toBe('open');
      // Defaults from the preprocess schema
      expect(reread?.trackedIssue?.body).toBe('');
      expect(reread?.trackedIssue?.labels).toEqual([]);
    });
  });

  it('round-trips an enriched tracked issue (with body and labels) unchanged', async () => {
    await withRepositories(async (repos) => {
      const setup = await createProjectConversationAndTopic(repos, {
        tenant: 'tenant_1',
        owner,
        identity: 'enriched-tracked-issue',
        title: 'Enriched tracked issue topic'
      });
      const enriched = {
        number: 71,
        title: 'feat: enriched',
        body: 'Full body text',
        labels: ['feature', 'backend'],
        state: 'open' as const,
        url: 'https://example.test/issues/71'
      };
      const run = await repos.runs.create({
        topicId: setup.topic.id,
        owner,
        tenant: 'tenant_1',
        workKind: 'feature',
        currentStep: 'spec.author',
        terminal: false,
        trackedIssue: enriched
      });
      expect(run.trackedIssue).toEqual(enriched);

      const reread = await repos.runs.findById(run.id);
      expect(reread?.trackedIssue).toEqual(enriched);
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

  it('lists runs by tenant only, newest first, with deterministic createdAt ties', async () => {
    await withRepositories(async (repos, database) => {
      const tenantOne = await createProjectConversationAndTopic(repos, {
        tenant: 'tenant_1',
        owner,
        identity: 'tenant-one',
        title: 'Tenant one'
      });
      const otherOwner = { ...owner, id: 'user_2', tenantId: 'tenant_2' } as const;
      const tenantTwo = await createProjectConversationAndTopic(repos, {
        tenant: 'tenant_2',
        owner: otherOwner,
        identity: 'tenant-two',
        title: 'Tenant two'
      });

      // Each active run needs its own topic due to the one-active-run-per-topic constraint
      const olderTopic = await repos.topics.create({
        conversationId: tenantOne.conversation.id,
        owner,
        tenant: 'tenant_1',
        title: 'Older topic',
        kind: 'side'
      });
      const tieLowTopic = await repos.topics.create({
        conversationId: tenantOne.conversation.id,
        owner,
        tenant: 'tenant_1',
        title: 'Tie low topic',
        kind: 'side'
      });
      const tieHighTopic = await repos.topics.create({
        conversationId: tenantOne.conversation.id,
        owner,
        tenant: 'tenant_1',
        title: 'Tie high topic',
        kind: 'side'
      });

      const older = await repos.runs.create({
        topicId: olderTopic.id,
        owner,
        tenant: 'tenant_1',
        workKind: 'feature',
        currentStep: 'spec.author',
        terminal: false
      });
      const tieLow = await repos.runs.create({
        topicId: tieLowTopic.id,
        owner,
        tenant: 'tenant_1',
        workKind: 'bug',
        currentStep: 'impl.build',
        terminal: false
      });
      const tieHigh = await repos.runs.create({
        topicId: tieHighTopic.id,
        owner,
        tenant: 'tenant_1',
        workKind: 'chore',
        currentStep: 'review',
        terminal: false
      });
      const otherTenant = await repos.runs.create({
        topicId: tenantTwo.topic.id,
        owner: otherOwner,
        tenant: 'tenant_2',
        workKind: 'feature',
        currentStep: 'spec.author',
        terminal: false
      });

      // Manipulate createdAt via raw SQL to control ordering
      asInternalSqliteDatabase(database).client.prepare('UPDATE runs SET created_at = ? WHERE id = ?').run('2026-06-11T10:00:00.000Z', older.id);
      asInternalSqliteDatabase(database).client.prepare('UPDATE runs SET created_at = ? WHERE id = ?').run('2026-06-11T12:00:00.000Z', tieLow.id);
      asInternalSqliteDatabase(database).client.prepare('UPDATE runs SET created_at = ? WHERE id = ?').run('2026-06-11T12:00:00.000Z', tieHigh.id);
      asInternalSqliteDatabase(database).client.prepare('UPDATE runs SET created_at = ? WHERE id = ?').run('2026-06-11T13:00:00.000Z', otherTenant.id);

      const listed = await repos.runs.listByTenant('tenant_1');
      const expectedTieOrder = [tieLow.id, tieHigh.id].sort().reverse();

      expect(listed.map((run) => run.id)).toEqual([...expectedTieOrder, older.id]);
      expect(listed.map((run) => run.tenant)).toEqual(['tenant_1', 'tenant_1', 'tenant_1']);
      expect(listed.some((run) => run.id === otherTenant.id)).toBe(false);
    });
  });

  it('honors explicit run list limits and exposes the default cap', async () => {
    await withRepositories(async (repos) => {
      const setup = await createProjectConversationAndTopic(repos, {
        tenant: 'tenant_1',
        owner,
        identity: 'limits',
        title: 'Limits'
      });
      const runIds: string[] = [];
      for (const idx of [0, 1, 2]) {
        // Each run needs its own topic due to the one-active-run-per-topic constraint
        const topic = await repos.topics.create({
          conversationId: setup.conversation.id,
          owner,
          tenant: 'tenant_1',
          title: `Limits topic ${idx}`,
          kind: 'side'
        });
        const run = await repos.runs.create({
          topicId: topic.id,
          owner,
          tenant: 'tenant_1',
          workKind: 'feature',
          currentStep: `step_${idx}`,
          terminal: false
        });
        runIds.push(run.id);
      }

      expect(defaultRunListLimit).toBe(100);
      await expect(repos.runs.listByTenant('tenant_1', { limit: 1 })).resolves.toHaveLength(1);
      await expect(repos.runs.listByTenant('tenant_1', { limit: defaultRunListLimit + 10 })).resolves.toHaveLength(runIds.length);
    });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid run list limit %s',
    async (limit) => {
      await withRepositories(async (repos) => {
        await expect(repos.runs.listByTenant('tenant_1', { limit })).rejects.toThrow(RangeError);
      });
    }
  );

  it('artifacts.findByRunAndKind returns the artifact when present and null otherwise', async () => {
    await withRepositories(async (repos) => {
      const setup = await createProjectConversationAndTopic(repos, {
        tenant: 'tenant_1',
        owner,
        identity: 'art-find',
        title: 'Art find'
      });
      const run = await repos.runs.create({
        topicId: setup.topic.id,
        owner,
        tenant: 'tenant_1',
        workKind: 'feature',
        currentStep: 'spec.author',
        terminal: false
      });

      const noneYet = await repos.artifacts.findByRunAndKind({ runId: run.id, kind: 'feature_spec' });
      expect(noneYet).toBeNull();

      const artifact = await repos.artifacts.create({
        runId: run.id,
        owner,
        tenant: 'tenant_1',
        kind: 'feature_spec',
        canonicalRecord: 'file',
        location: 'context-human/specs/feature.md',
        cachedStatus: 'draft',
        publicationRefs: []
      });

      const found = await repos.artifacts.findByRunAndKind({ runId: run.id, kind: 'feature_spec' });
      expect(found?.id).toBe(artifact.id);

      const otherKind = await repos.artifacts.findByRunAndKind({ runId: run.id, kind: 'enhancement_spec' });
      expect(otherKind).toBeNull();
    });
  });

  it('artifacts.updateCachedStatus updates the cached status and updatedAt', async () => {
    await withRepositories(async (repos) => {
      const setup = await createProjectConversationAndTopic(repos, {
        tenant: 'tenant_1',
        owner,
        identity: 'art-upd',
        title: 'Art upd'
      });
      const run = await repos.runs.create({
        topicId: setup.topic.id,
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
        location: 'context-human/specs/feature.md',
        cachedStatus: 'draft',
        publicationRefs: []
      });

      const newUpdatedAt = '2026-06-12T00:00:00.000Z';
      const updated = await repos.artifacts.updateCachedStatus({
        artifactId: artifact.id,
        cachedStatus: 'approved',
        updatedAt: newUpdatedAt
      });
      expect(updated.cachedStatus).toBe('approved');
      expect(updated.updatedAt).toBe(newUpdatedAt);

      const reread = await repos.artifacts.findById(artifact.id);
      expect(reread?.cachedStatus).toBe('approved');
      expect(reread?.updatedAt).toBe(newUpdatedAt);
    });
  });

  it('feedback.updateStatusAndAppendThread atomically updates status and appends a thread entry', async () => {
    await withRepositories(async (repos) => {
      const setup = await createProjectConversationAndTopic(repos, {
        tenant: 'tenant_1',
        owner,
        identity: 'fb-tr',
        title: 'Feedback transition'
      });
      const run = await repos.runs.create({
        topicId: setup.topic.id,
        owner,
        tenant: 'tenant_1',
        workKind: 'feature',
        currentStep: 'spec.author',
        terminal: false
      });
      const fb = await repos.feedback.create({
        runId: run.id,
        owner,
        tenant: 'tenant_1',
        target: 'artifact',
        status: 'open',
        title: 'Needs detail',
        body: 'Please add more context.',
        thread: [{ id: 'thread_1', author: owner, body: 'Please add more context.', createdAt: '2026-06-08T00:00:00.000Z' }]
      });

      const newUpdatedAt = '2026-06-12T01:00:00.000Z';
      const newEntry = {
        id: 'thread_2',
        author: owner,
        body: 'Resolving with updated text.',
        createdAt: '2026-06-12T00:59:00.000Z'
      } as const;
      const result = await repos.feedback.updateStatusAndAppendThread({
        feedbackId: fb.id,
        expectedStatus: 'open',
        nextStatus: 'resolved',
        threadEntry: newEntry,
        updatedAt: newUpdatedAt
      });
      expect(result.status).toBe('resolved');
      expect(result.updatedAt).toBe(newUpdatedAt);
      expect(result.thread).toHaveLength(2);
      expect(result.thread[1]?.id).toBe('thread_2');

      const reread = await repos.feedback.findById(fb.id);
      expect(reread?.status).toBe('resolved');
      expect(reread?.thread).toHaveLength(2);
    });
  });

  it('feedback.updateStatusAndAppendThread throws FeedbackConcurrentModificationError when expectedStatus mismatches', async () => {
    await withRepositories(async (repos) => {
      const setup = await createProjectConversationAndTopic(repos, {
        tenant: 'tenant_1',
        owner,
        identity: 'fb-cc',
        title: 'Feedback concurrency'
      });
      const run = await repos.runs.create({
        topicId: setup.topic.id,
        owner,
        tenant: 'tenant_1',
        workKind: 'feature',
        currentStep: 'spec.author',
        terminal: false
      });
      const fb = await repos.feedback.create({
        runId: run.id,
        owner,
        tenant: 'tenant_1',
        target: 'artifact',
        status: 'open',
        title: 'Title',
        body: 'Body',
        thread: [{ id: 'thread_1', author: owner, body: 'Body', createdAt: '2026-06-08T00:00:00.000Z' }]
      });

      await expect(
        repos.feedback.updateStatusAndAppendThread({
          feedbackId: fb.id,
          expectedStatus: 'resolved',
          nextStatus: 'resolved',
          threadEntry: { id: 'thread_x', author: owner, body: 'noop', createdAt: '2026-06-12T01:00:00.000Z' },
          updatedAt: '2026-06-12T01:00:00.000Z'
        })
      ).rejects.toBeInstanceOf(FeedbackConcurrentModificationError);
    });
  });

  it('feedback.appendThreadEntry appends a reply without changing status', async () => {
    await withRepositories(async (repos) => {
      const setup = await createProjectConversationAndTopic(repos, {
        tenant: 'tenant_1',
        owner,
        identity: 'fb-append',
        title: 'Feedback append reply'
      });
      const run = await repos.runs.create({
        topicId: setup.topic.id,
        owner,
        tenant: 'tenant_1',
        workKind: 'feature',
        currentStep: 'spec.author',
        terminal: false
      });
      const fb = await repos.feedback.create({
        runId: run.id,
        owner,
        tenant: 'tenant_1',
        target: 'artifact',
        status: 'open',
        title: 'Needs reply',
        body: 'Initial body.',
        thread: [{ id: 'thread_1', author: owner, body: 'Initial body.', createdAt: '2026-06-14T00:00:00.000Z' }]
      });

      const updated = await repos.feedback.appendThreadEntry({
        feedbackId: fb.id,
        threadEntry: {
          id: 'thread_reply',
          author: owner,
          body: 'Reply body',
          createdAt: '2026-06-15T12:00:00.000Z'
        },
        updatedAt: '2026-06-15T12:00:00.000Z'
      });

      expect(updated.status).toBe(fb.status);
      expect(updated.thread).toHaveLength(2);
      expect(updated.thread.at(-1)?.body).toBe('Reply body');
      expect(updated.updatedAt).toBe('2026-06-15T12:00:00.000Z');

      const reread = await repos.feedback.findById(fb.id);
      expect(reread?.status).toBe('open');
      expect(reread?.thread).toHaveLength(2);
      expect(reread?.thread.at(-1)?.id).toBe('thread_reply');
    });
  });

  it('omits failureReason for newly created runs', async () => {
    await withRepositories(async (repos) => {
      const setup = await createProjectConversationAndTopic(repos, {
        tenant: 'tenant_1',
        owner,
        identity: 'run-no-failure',
        title: 'No failure'
      });
      const run = await repos.runs.create({
        topicId: setup.topic.id,
        owner,
        tenant: 'tenant_1',
        workKind: 'feature',
        currentStep: 'spec.author',
        terminal: false
      });
      expect(run.failureReason).toBeUndefined();

      const found = await repos.runs.findById(run.id);
      expect(found?.failureReason).toBeUndefined();
    });
  });

  it('persists failureReason when recordRunStepTransition fails a run', async () => {
    await withRepositories(async (repos) => {
      const setup = await createProjectConversationAndTopic(repos, {
        tenant: 'tenant_1',
        owner,
        identity: 'run-fail-reason',
        title: 'Fail reason'
      });
      const { run } = await repos.runs.recordRunLifecycleStart({
        run: { topicId: setup.topic.id, owner, tenant: 'tenant_1', workKind: 'feature', currentStep: 'intake', terminal: false },
        runStep: { phase: null, step: 'intake', role: 'none', startedAt: new Date().toISOString(), endedAt: null, durationMs: null }
      });

      const recorded = await repos.runs.recordRunStepTransition({
        runId: run.id,
        currentStep: 'failed',
        terminal: true,
        failureReason: 'provider_auth_failed',
        runStep: { phase: null, step: 'failed', role: 'none', startedAt: new Date().toISOString(), endedAt: null, durationMs: null }
      });
      expect(recorded.run.failureReason).toBe('provider_auth_failed');

      const found = await repos.runs.findById(run.id);
      expect(found?.failureReason).toBe('provider_auth_failed');
    });
  });

  it('round-trips an artifact_range feedback anchor with emoji codepoints', async () => {
    // "😄" is one Unicode codepoint (U+1F604) but two UTF-16 code units
    await withRepositories(async (repos) => {
      const setup = await createProjectConversationAndTopic(repos, {
        tenant: 'tenant_1',
        owner,
        identity: 'art-range',
        title: 'Artifact range'
      });
      const run = await repos.runs.create({
        topicId: setup.topic.id,
        owner,
        tenant: 'tenant_1',
        workKind: 'feature',
        currentStep: 'spec.author',
        terminal: false
      });

      const anchor = {
        kind: 'artifact_range' as const,
        artifactId: 'art_spec_1',
        from: 6,
        to: 8,
        quotedText: '😄x'
      };

      const fb = await repos.feedback.create({
        runId: run.id,
        owner,
        tenant: 'tenant_1',
        target: 'artifact',
        status: 'open',
        title: 'Range feedback',
        body: 'Test anchor round-trip.',
        anchor,
        thread: [{ id: 'thread_1', author: owner, body: 'Test anchor round-trip.', createdAt: '2026-06-14T00:00:00.000Z' }]
      });

      const found = await repos.feedback.findById(fb.id);
      expect(found?.anchor).toEqual(anchor);
    });
  });

  it('clears stale failureReason when a transition targets a non-failed state', async () => {
    await withRepositories(async (repos) => {
      const setup = await createProjectConversationAndTopic(repos, {
        tenant: 'tenant_1',
        owner,
        identity: 'run-clear-failure',
        title: 'Clear failure'
      });
      const { run } = await repos.runs.recordRunLifecycleStart({
        run: { topicId: setup.topic.id, owner, tenant: 'tenant_1', workKind: 'feature', currentStep: 'intake', terminal: false },
        runStep: { phase: null, step: 'intake', role: 'none', startedAt: new Date().toISOString(), endedAt: null, durationMs: null }
      });

      await repos.runs.recordRunStepTransition({
        runId: run.id,
        currentStep: 'failed',
        terminal: true,
        failureReason: 'provider_auth_failed',
        runStep: { phase: null, step: 'failed', role: 'none', startedAt: new Date().toISOString(), endedAt: null, durationMs: null }
      });

      const recovered = await repos.runs.recordRunStepTransition({
        runId: run.id,
        currentStep: 'spec.human_review',
        terminal: false,
        runStep: { phase: 'spec', step: 'spec.human_review', role: 'none', startedAt: new Date().toISOString(), endedAt: null, durationMs: null }
      });
      expect(recovered.run.failureReason).toBeUndefined();

      const found = await repos.runs.findById(run.id);
      expect(found?.failureReason).toBeUndefined();
    });
  });

  it('runSteps.updateCheckpoint stores a convergence checkpoint and preserves other fields', async () => {
    await withRepositories(async (repos) => {
      const setup = await createProjectConversationAndTopic(repos, {
        tenant: 'tenant_1',
        owner,
        identity: 'cp-store',
        title: 'Checkpoint store'
      });
      const run = await repos.runs.create({
        topicId: setup.topic.id,
        owner,
        tenant: 'tenant_1',
        workKind: 'feature',
        currentStep: 'implementation.build',
        terminal: false
      });
      const step = await repos.runSteps.create({
        runId: run.id,
        phase: 'implementation',
        step: 'implementation.build',
        role: 'implementer',
        startedAt: '2026-06-15T00:00:00.000Z',
        endedAt: null,
        durationMs: null,
        occurrence: { index: 0, attempt: 1 }
      });
      expect(step.checkpointResult).toBeNull();

      const checkpoint = {
        kind: 'convergence_review' as const,
        step: 'implementation.build',
        maxRounds: 3,
        routing: { distinct: true, distinctBy: 'model' as const },
        rounds: [],
        outcome: 'converged' as const,
        openFeedbackIds: [],
        lastPositions: {}
      };

      const updated = await repos.runSteps.updateCheckpoint({
        runStepId: step.id,
        runId: run.id,
        tenant: 'tenant_1',
        checkpointResult: checkpoint
      });

      expect(updated.id).toBe(step.id);
      expect(updated.runId).toBe(run.id);
      expect(updated.step).toBe('implementation.build');
      expect(updated.occurrence).toEqual(step.occurrence);
      expect(updated.checkpointResult).toEqual(checkpoint);

      const reread = await repos.runSteps.findById(step.id);
      expect(reread?.checkpointResult).toEqual(checkpoint);
    });
  });

  it('runSteps.updateCheckpoint rejects when run step does not belong to tenant or run', async () => {
    await withRepositories(async (repos) => {
      const setup = await createProjectConversationAndTopic(repos, {
        tenant: 'tenant_1',
        owner,
        identity: 'cp-reject',
        title: 'Checkpoint reject'
      });
      const run = await repos.runs.create({
        topicId: setup.topic.id,
        owner,
        tenant: 'tenant_1',
        workKind: 'feature',
        currentStep: 'implementation.build',
        terminal: false
      });
      const step = await repos.runSteps.create({
        runId: run.id,
        phase: 'implementation',
        step: 'implementation.build',
        role: 'implementer',
        startedAt: '2026-06-15T00:00:00.000Z',
        endedAt: null,
        durationMs: null,
        occurrence: { index: 0, attempt: 1 }
      });
      const checkpoint = {
        kind: 'convergence_review' as const,
        step: 'implementation.build',
        maxRounds: 3,
        routing: { distinct: true, distinctBy: 'model' as const },
        rounds: [],
        outcome: 'converged' as const,
        openFeedbackIds: [],
        lastPositions: {}
      };

      await expect(
        repos.runSteps.updateCheckpoint({
          runStepId: step.id,
          runId: run.id,
          tenant: 'tenant_other',
          checkpointResult: checkpoint
        })
      ).rejects.toThrow();

      await expect(
        repos.runSteps.updateCheckpoint({
          runStepId: step.id,
          runId: 'run_nonexistent',
          tenant: 'tenant_1',
          checkpointResult: checkpoint
        })
      ).rejects.toThrow();
    });
  });

  it('runSteps.updateCheckpoint preserves previous round records when a later round is appended', async () => {
    await withRepositories(async (repos) => {
      const setup = await createProjectConversationAndTopic(repos, {
        tenant: 'tenant_1',
        owner,
        identity: 'cp-rounds',
        title: 'Checkpoint rounds'
      });
      const run = await repos.runs.create({
        topicId: setup.topic.id,
        owner,
        tenant: 'tenant_1',
        workKind: 'feature',
        currentStep: 'implementation.build',
        terminal: false
      });
      const step = await repos.runSteps.create({
        runId: run.id,
        phase: 'implementation',
        step: 'implementation.build',
        role: 'implementer',
        startedAt: '2026-06-15T00:00:00.000Z',
        endedAt: null,
        durationMs: null,
        occurrence: { index: 0, attempt: 1 }
      });

      // Write checkpoint with round 1 data
      const oneRoundCheckpoint = {
        kind: 'convergence_review' as const,
        step: 'implementation.build',
        maxRounds: 3,
        routing: { distinct: true, distinctBy: 'model' as const },
        rounds: [
          { round: 1, changedFileCount: 1, findings: [], dispositions: [], outcome: 'continue' as const }
        ],
        outcome: 'converged' as const,
        openFeedbackIds: [],
        lastPositions: {}
      };

      await repos.runSteps.updateCheckpoint({
        runStepId: step.id,
        runId: run.id,
        tenant: 'tenant_1',
        checkpointResult: oneRoundCheckpoint
      });

      // Read back and verify round 1 data is there
      const afterRound1 = await repos.runSteps.findById(step.id);
      expect(afterRound1?.checkpointResult).not.toBeNull();
      const cp1 = afterRound1?.checkpointResult as typeof oneRoundCheckpoint;
      expect(cp1.rounds).toHaveLength(1);
      expect(cp1.rounds[0].round).toBe(1);

      // Write checkpoint with rounds 1+2 data
      const twoRoundCheckpoint = {
        kind: 'convergence_review' as const,
        step: 'implementation.build',
        maxRounds: 3,
        routing: { distinct: true, distinctBy: 'model' as const },
        rounds: [
          { round: 1, changedFileCount: 1, findings: [], dispositions: [], outcome: 'continue' as const },
          { round: 2, changedFileCount: 0, findings: [], dispositions: [], outcome: 'converged' as const }
        ],
        outcome: 'converged' as const,
        openFeedbackIds: [],
        lastPositions: {}
      };

      await repos.runSteps.updateCheckpoint({
        runStepId: step.id,
        runId: run.id,
        tenant: 'tenant_1',
        checkpointResult: twoRoundCheckpoint
      });

      // Read back and verify BOTH rounds are there
      const afterRound2 = await repos.runSteps.findById(step.id);
      expect(afterRound2?.checkpointResult).not.toBeNull();
      const cp2 = afterRound2?.checkpointResult as typeof twoRoundCheckpoint;
      expect(cp2.rounds).toHaveLength(2);
      expect(cp2.rounds[0].round).toBe(1);
      expect(cp2.rounds[1].round).toBe(2);
      expect(cp2.rounds[1].outcome).toBe('converged');
    });
  });

  it('runSteps.updateCheckpoint rejects invalid convergence checkpoint JSON', async () => {
    await withRepositories(async (repos) => {
      const setup = await createProjectConversationAndTopic(repos, {
        tenant: 'tenant_1',
        owner,
        identity: 'cp-invalid',
        title: 'Checkpoint invalid'
      });
      const run = await repos.runs.create({
        topicId: setup.topic.id,
        owner,
        tenant: 'tenant_1',
        workKind: 'feature',
        currentStep: 'implementation.build',
        terminal: false
      });
      const step = await repos.runSteps.create({
        runId: run.id,
        phase: 'implementation',
        step: 'implementation.build',
        role: 'implementer',
        startedAt: '2026-06-15T00:00:00.000Z',
        endedAt: null,
        durationMs: null,
        occurrence: { index: 0, attempt: 1 }
      });

      await expect(
        repos.runSteps.updateCheckpoint({
          runStepId: step.id,
          runId: run.id,
          tenant: 'tenant_1',
          checkpointResult: { kind: 'convergence_review', step: '', maxRounds: 0 }
        })
      ).rejects.toThrow();
    });
  });
});
