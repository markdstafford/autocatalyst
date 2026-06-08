import { describe, expect, it } from 'vitest';

import {
  artifactSchema,
  conversationSchema,
  createRunInputSchema,
  feedbackSchema,
  messageSchema,
  projectSchema,
  publicationSchema,
  pullRequestSchema,
  runSchema,
  runStepSchema,
  sessionSchema,
  testResultSchema,
  topicSchema
} from '../index.js';

const owner = { id: 'user_1', kind: 'human', tenantId: 'tenant_1', displayName: 'Ada' } as const;
const modelPrincipal = { id: 'model_1', kind: 'model', tenantId: 'tenant_1', displayName: 'Model' } as const;
const now = '2026-06-08T00:00:00.000Z';
const tokens = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 };
const cost = { model: { provider: 'openai', model: 'gpt-4.1' }, usd: null, tokens };

describe('domain entity contracts', () => {
  it('validates owner and tenant for major entities and rejects model owners', () => {
    const project = projectSchema.parse({
      id: 'proj_1', owner, tenant: 'tenant_1', displayName: 'Autocatalyst', repoUrl: 'https://github.com/example/repo',
      hostRepository: { provider: 'github', owner: 'example', name: 'repo', url: 'https://github.com/example/repo' },
      workspaceRootOverride: null, issueTrackerSetting: null, codeHostSetting: null, credentialRefs: [],
      createdAt: now, updatedAt: now
    });
    expect(project.tenant).toBe(owner.tenantId);
    expect(() => projectSchema.parse({ ...project, owner: modelPrincipal })).toThrow();
    expect(() => projectSchema.parse({ ...project, tenant: 'other_tenant' })).toThrow();
  });

  it('models conversations with nullable activeTopicId and topics without an active flag', () => {
    expect(conversationSchema.parse({ id: 'conv_1', projectId: 'proj_1', owner, tenant: 'tenant_1', identity: 'issue-11', channel: { provider: 'slack', channelId: 'C1' }, activeTopicId: null, createdAt: now, updatedAt: now }).activeTopicId).toBeNull();
    expect(topicSchema.parse({ id: 'topic_1', conversationId: 'conv_1', owner, tenant: 'tenant_1', title: 'Main work', kind: 'main', createdAt: now, updatedAt: now }).kind).toBe('main');
    expect(() => topicSchema.parse({ id: 'topic_1', conversationId: 'conv_1', owner, tenant: 'tenant_1', title: 'Main work', kind: 'main', isActive: true, createdAt: now, updatedAt: now })).toThrow();
  });

  it('validates message direction and allows model authors where attribution permits', () => {
    expect(messageSchema.parse({ id: 'msg_1', topicId: 'topic_1', owner, tenant: 'tenant_1', author: modelPrincipal, direction: 'outbound', body: 'Generated reply', intent: 'answer', createdAt: now }).author.kind).toBe('model');
    expect(() => messageSchema.parse({ id: 'msg_1', topicId: 'topic_1', owner, tenant: 'tenant_1', author: owner, direction: 'internal', body: 'No', createdAt: now })).toThrow();
  });

  it('models runs with currentStep and terminal only, never closed status vocabulary', () => {
    const input = createRunInputSchema.parse({ topicId: 'topic_1', owner, tenant: 'tenant_1', workKind: 'feature', currentStep: 'future.custom_step', terminal: false, trackedIssue: { number: 11, title: 'Persistence', state: 'open', url: 'https://example.test/issues/11' }, testingGuideResult: { status: 'not_run' } });
    expect(input.currentStep).toBe('future.custom_step');
    expect(() => runSchema.parse({ id: 'run_1', ...input, status: 'running', createdAt: now, updatedAt: now })).toThrow();
  });

  it('validates run-owned entities and embedded value objects', () => {
    expect(artifactSchema.parse({ id: 'art_1', runId: 'run_1', owner, tenant: 'tenant_1', kind: 'feature_spec', canonicalRecord: 'file', location: 'context-human/specs/example.md', cachedStatus: 'approved', linkedIssue: { number: 11, title: 'Persistence', state: 'open', url: 'https://example.test/issues/11' }, publicationRefs: ['pub_1'], createdAt: now, updatedAt: now }).cachedStatus).toBe('approved');
    expect(feedbackSchema.parse({ id: 'fb_1', runId: 'run_1', owner, tenant: 'tenant_1', target: 'artifact', status: 'open', title: 'Clarify status', body: 'Needs more detail.', anchor: { kind: 'artifact', artifactId: 'art_1' }, thread: [{ id: 'thread_1', author: owner, body: 'Needs more detail.', createdAt: now }], createdAt: now, updatedAt: now }).thread).toHaveLength(1);
    expect(publicationSchema.parse({ id: 'pub_1', runId: 'run_1', owner, tenant: 'tenant_1', provider: 'github', url: 'https://example.test/pub/1', label: 'Spec', frontedResource: { kind: 'artifact', id: 'art_1' }, createdAt: now, updatedAt: now }).frontedResource.kind).toBe('artifact');
    expect(pullRequestSchema.parse({ id: 'pr_1', runId: 'run_1', owner, tenant: 'tenant_1', provider: 'github', number: 12, url: 'https://example.test/pull/12', state: 'open', branch: 'feature/persistence-run', createdAt: now, updatedAt: now }).state).toBe('open');
  });

  it('validates run-step, session, and test-result parent-hung records without owner or tenant', () => {
    expect(runStepSchema.parse({ id: 'step_1', runId: 'run_1', phase: 'implementation', step: 'implementation.build', role: 'implementer', startedAt: now, endedAt: null, durationMs: null, occurrence: { index: 0, attempt: 1 } }).role).toBe('implementer');
    expect(sessionSchema.parse({ id: 'sess_1', runId: 'run_1', phase: null, step: 'intake.classify', role: 'none', round: 0, model: { provider: 'openai', model: 'gpt-4.1' }, inferenceSettings: { extra: { responseFormat: 'json' } }, startedAt: now, endedAt: now, durationMs: 100, tokens, usageAvailable: true, assistantTurnCount: 1, toolCallCount: 0, outcome: 'succeeded', cost }).cost.usd).toBeNull();
    expect(() => sessionSchema.parse({ id: 'sess_2', runId: 'run_1', phase: null, step: 'intake.classify', role: 'none', round: 0, model: { provider: 'openai', model: 'gpt-4.1' }, inferenceSettings: {}, startedAt: now, endedAt: now, durationMs: 100, tokens, usageAvailable: true, assistantTurnCount: 1, toolCallCount: 0, outcome: 'succeeded', cost: { ...cost, tokens: { ...tokens, output: 999 } } })).toThrow();
    expect(testResultSchema.parse({ id: 'test_1', runId: 'run_1', tester: owner, outcome: 'passed', evidence: { kind: 'external', summary: 'Manual smoke test passed.' }, feedbackRefs: ['fb_1'], createdAt: now, updatedAt: now }).outcome).toBe('passed');
  });
});
