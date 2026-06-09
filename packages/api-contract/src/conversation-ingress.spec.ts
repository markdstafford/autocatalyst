import { describe, expect, it } from 'vitest';

import {
  conversationCollectionPath,
  createConversationSuccessStatusCode,
  createConversationWithFirstRunRequestSchema,
  createConversationWithFirstRunResponseSchema,
  submissionKindSchema
} from './conversation-ingress.js';

const owner = { id: 'user_1', kind: 'human' as const, tenantId: 'tenant_abc' };

const validRequest = {
  projectId: 'proj_123',
  identity: 'Issue 15',
  channel: {
    provider: 'github',
    channelId: '15',
    url: 'https://github.com/example/repo/issues/15'
  },
  topic: { title: 'Add orchestrator service ingress' },
  submission: {
    kind: 'issue_reference',
    body: 'please work on issue 15',
    workKind: 'feature',
    trackedIssue: {
      number: 15,
      title: 'feat: add orchestrator ingress',
      state: 'open',
      url: 'https://github.com/example/repo/issues/15'
    }
  }
};

describe('conversation-ingress contract', () => {
  it('exports the collection path constant', () => {
    expect(conversationCollectionPath).toBe('/v1/conversations');
  });

  it('exports the success status code constant', () => {
    expect(createConversationSuccessStatusCode).toBe(201);
  });

  it('validates valid submission kinds', () => {
    expect(submissionKindSchema.parse('issue_reference')).toBe('issue_reference');
    expect(submissionKindSchema.parse('free_form')).toBe('free_form');
    expect(submissionKindSchema.parse('question')).toBe('question');
    expect(submissionKindSchema.parse('list_to_file')).toBe('list_to_file');
  });

  it('rejects unknown submission kinds', () => {
    expect(() => submissionKindSchema.parse('unknown_kind')).toThrow();
  });

  it('parses a valid create conversation request', () => {
    expect(createConversationWithFirstRunRequestSchema.parse(validRequest)).toEqual(validRequest);
  });

  it('requires projectId', () => {
    const { projectId: _omit, ...rest } = validRequest;
    expect(() => createConversationWithFirstRunRequestSchema.parse(rest)).toThrow();
  });

  it('requires identity', () => {
    const { identity: _omit, ...rest } = validRequest;
    expect(() => createConversationWithFirstRunRequestSchema.parse(rest)).toThrow();
  });

  it('requires topic with title', () => {
    expect(() =>
      createConversationWithFirstRunRequestSchema.parse({ ...validRequest, topic: {} })
    ).toThrow();
  });

  it('requires submission', () => {
    const { submission: _omit, ...rest } = validRequest;
    expect(() => createConversationWithFirstRunRequestSchema.parse(rest)).toThrow();
  });

  it('requires submission.workKind', () => {
    const { workKind: _omit, ...submissionRest } = validRequest.submission;
    expect(() =>
      createConversationWithFirstRunRequestSchema.parse({
        ...validRequest,
        submission: submissionRest
      })
    ).toThrow();
  });

  it('allows omitting channel', () => {
    const { channel: _omit, ...rest } = validRequest;
    expect(() => createConversationWithFirstRunRequestSchema.parse(rest)).not.toThrow();
  });

  it('allows omitting trackedIssue in submission', () => {
    const { trackedIssue: _omit, ...submissionRest } = validRequest.submission;
    expect(() =>
      createConversationWithFirstRunRequestSchema.parse({
        ...validRequest,
        submission: submissionRest
      })
    ).not.toThrow();
  });

  it('rejects extra fields in request (strict)', () => {
    expect(() =>
      createConversationWithFirstRunRequestSchema.parse({ ...validRequest, extra: 'field' })
    ).toThrow();
  });

  it('parses a valid create conversation response', () => {
    const now = new Date().toISOString();
    const validResponse = {
      conversation: {
        id: 'conv_1',
        projectId: 'proj_123',
        owner,
        tenant: 'tenant_abc',
        identity: 'Issue 15',
        activeTopicId: 'topic_1',
        createdAt: now,
        updatedAt: now
      },
      topic: {
        id: 'topic_1',
        conversationId: 'conv_1',
        owner,
        tenant: 'tenant_abc',
        title: 'Add orchestrator service ingress',
        kind: 'main',
        createdAt: now,
        updatedAt: now
      },
      run: {
        id: 'run_1',
        topicId: 'topic_1',
        owner,
        tenant: 'tenant_abc',
        workKind: 'feature',
        currentStep: 'start',
        terminal: false,
        createdAt: now,
        updatedAt: now
      },
      runStep: {
        id: 'step_1',
        runId: 'run_1',
        phase: null,
        step: 'start',
        role: 'orchestrator',
        startedAt: now,
        endedAt: null,
        durationMs: null,
        occurrence: { index: 0, attempt: 1 }
      }
    };
    expect(createConversationWithFirstRunResponseSchema.parse(validResponse)).toEqual(validResponse);
  });

  it('allows an optional message in the response', () => {
    const now = new Date().toISOString();
    const validResponse = {
      conversation: {
        id: 'conv_1',
        projectId: 'proj_123',
        owner,
        tenant: 'tenant_abc',
        identity: 'Issue 15',
        activeTopicId: 'topic_1',
        createdAt: now,
        updatedAt: now
      },
      topic: {
        id: 'topic_1',
        conversationId: 'conv_1',
        owner,
        tenant: 'tenant_abc',
        title: 'Add orchestrator service ingress',
        kind: 'main',
        createdAt: now,
        updatedAt: now
      },
      message: {
        id: 'msg_1',
        topicId: 'topic_1',
        owner,
        tenant: 'tenant_abc',
        author: { id: 'user_1', kind: 'human', tenantId: 'tenant_abc' },
        direction: 'inbound',
        body: 'please work on issue 15',
        createdAt: now
      },
      run: {
        id: 'run_1',
        topicId: 'topic_1',
        owner,
        tenant: 'tenant_abc',
        workKind: 'feature',
        currentStep: 'start',
        terminal: false,
        createdAt: now,
        updatedAt: now
      },
      runStep: {
        id: 'step_1',
        runId: 'run_1',
        phase: null,
        step: 'start',
        role: 'orchestrator',
        startedAt: now,
        endedAt: null,
        durationMs: null,
        occurrence: { index: 0, attempt: 1 }
      }
    };
    expect(createConversationWithFirstRunResponseSchema.parse(validResponse)).toEqual(validResponse);
  });
});
