import { describe, expect, it } from 'vitest';

import {
  conversationCollectionPath,
  createConversationSuccessStatusCode,
  createConversationSubmissionSchema,
  createConversationWithFirstRunRequestSchema,
  createConversationWithFirstRunResponseSchema,
  explicitWorkSubmissionSchema,
  freeFormSubmissionSchema,
  issueReferenceSubmissionSchema,
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
    issue: { number: 15 }
  }
};

const baseRequest = {
  projectId: 'proj_123',
  identity: 'Issue 71',
  topic: { title: 'Work on issue 71' }
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

  it('requires workKind for question submissions', () => {
    expect(() =>
      createConversationWithFirstRunRequestSchema.parse({
        ...validRequest,
        submission: { kind: 'question', body: 'What is the plan?' }
      })
    ).toThrow();
  });

  it('allows omitting channel', () => {
    const { channel: _omit, ...rest } = validRequest;
    expect(() => createConversationWithFirstRunRequestSchema.parse(rest)).not.toThrow();
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
        occurrence: { index: 0, attempt: 1 },
        checkpointResult: null
      }
    };
    expect(createConversationWithFirstRunResponseSchema.parse(validResponse)).toEqual(validResponse);
  });

  it('exports sub-schemas for issue_reference, free_form, and explicit work submissions', () => {
    expect(issueReferenceSubmissionSchema).toBeDefined();
    expect(freeFormSubmissionSchema).toBeDefined();
    expect(explicitWorkSubmissionSchema).toBeDefined();
    expect(createConversationSubmissionSchema).toBeDefined();
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
        occurrence: { index: 0, attempt: 1 },
        checkpointResult: null
      }
    };
    expect(createConversationWithFirstRunResponseSchema.parse(validResponse)).toEqual(validResponse);
  });
});

describe('createConversationWithFirstRunRequestSchema submissions', () => {
  it('accepts structured issue references without workKind or trackedIssue', () => {
    expect(createConversationWithFirstRunRequestSchema.parse({
      ...baseRequest,
      submission: {
        kind: 'issue_reference',
        body: 'please work on issue 71',
        issue: { number: 71 }
      }
    }).submission).toEqual({
      kind: 'issue_reference',
      body: 'please work on issue 71',
      issue: { number: 71 }
    });
  });

  it('accepts text-only free_form so intake can recognize issue references', () => {
    expect(createConversationWithFirstRunRequestSchema.parse({
      ...baseRequest,
      submission: { kind: 'free_form', body: 'work on issue #71' }
    }).submission).toEqual({ kind: 'free_form', body: 'work on issue #71' });
  });

  it('keeps explicit non-issue submissions valid with required workKind', () => {
    expect(createConversationWithFirstRunRequestSchema.parse({
      ...baseRequest,
      identity: 'Question',
      submission: { kind: 'question', body: 'What is the plan?', workKind: 'question' }
    }).submission).toEqual({ kind: 'question', body: 'What is the plan?', workKind: 'question' });
  });

  it('rejects missing issue numbers and extra branch properties', () => {
    expect(() => createConversationWithFirstRunRequestSchema.parse({
      ...baseRequest,
      submission: { kind: 'issue_reference', body: 'issue please', issue: {} }
    })).toThrow();
    expect(() => createConversationWithFirstRunRequestSchema.parse({
      ...baseRequest,
      submission: { kind: 'issue_reference', body: 'issue please', issue: { number: 71 }, trackedIssue: {} }
    })).toThrow();
  });
});
