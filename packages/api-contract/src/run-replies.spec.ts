import { describe, expect, it } from 'vitest';

import {
  createRunReplySuccessStatusCode,
  runRepliesPath,
  runReplyClassificationSchema,
  runReplyRequestSchema,
  runReplyResponseSchema
} from './run-replies.js';

const run = {
  id: 'run_1',
  topicId: 'topic_1',
  owner: { kind: 'human', id: 'user_1', tenantId: 'tenant_1' },
  tenant: 'tenant_1',
  workKind: 'feature',
  currentStep: 'spec.human_review',
  waitingOn: 'human',
  terminal: false,
  createdAt: '2026-06-15T00:00:00.000Z',
  updatedAt: '2026-06-15T00:00:00.000Z'
};

describe('run replies contract', () => {
  it('publishes the route path and success status', () => {
    expect(runRepliesPath).toBe('/v1/runs/:id/replies');
    expect(createRunReplySuccessStatusCode).toBe(200);
  });

  it('accepts strict approve, feedback, and guidance requests', () => {
    expect(runReplyRequestSchema.parse({ kind: 'approve', body: 'Ship it.' })).toEqual({ kind: 'approve', body: 'Ship it.' });
    expect(runReplyRequestSchema.parse({ kind: 'approve' })).toEqual({ kind: 'approve' });
    expect(runReplyRequestSchema.parse({ kind: 'feedback', title: 'Clarify risk', body: 'Add provider failure details.' })).toEqual({
      kind: 'feedback',
      title: 'Clarify risk',
      body: 'Add provider failure details.'
    });
    expect(runReplyRequestSchema.parse({ kind: 'guidance', body: 'Prefer the public API option.' })).toEqual({
      kind: 'guidance',
      body: 'Prefer the public API option.'
    });
  });

  it('rejects malformed or extra request fields', () => {
    expect(() => runReplyRequestSchema.parse({ kind: 'answer', body: '42' })).toThrow();
    expect(() => runReplyRequestSchema.parse({ kind: 'feedback', body: 'Missing title' })).toThrow();
    expect(() => runReplyRequestSchema.parse({ kind: 'guidance', body: '' })).toThrow();
    expect(() => runReplyRequestSchema.parse({ kind: 'approve', target: 'implementation' })).toThrow();
  });

  it('parses classification and response payloads', () => {
    expect(runReplyClassificationSchema.parse({ directive: 'advance', target: 'artifact' })).toEqual({ directive: 'advance', target: 'artifact' });
    expect(runReplyClassificationSchema.parse({ directive: 'advance', pauseKind: 'convergence_escalation' })).toEqual({
      directive: 'advance',
      pauseKind: 'convergence_escalation'
    });
    expect(runReplyResponseSchema.parse({ run, classification: { directive: 'revise', target: 'implementation', createdFeedbackId: 'fb_1' } })).toEqual({
      run,
      classification: { directive: 'revise', target: 'implementation', createdFeedbackId: 'fb_1' }
    });
  });
});
