import { describe, expect, it } from 'vitest';

import {
  runFeedbackPath,
  createRunFeedbackSuccessStatusCode,
  listRunFeedbackSuccessStatusCode,
  createRunFeedbackRequestSchema,
  runFeedbackListResponseSchema
} from './feedback.js';

const validFeedbackItem = {
  id: 'fb_1',
  runId: 'run_1',
  owner: { kind: 'human' as const, id: 'user_1', tenantId: 'tenant_1', displayName: 'Phoebe' },
  tenant: 'tenant_1',
  target: 'artifact' as const,
  status: 'open' as const,
  title: 'Please clarify scope',
  body: 'The scope section is ambiguous.',
  thread: [{
    id: 'thread_1',
    author: { kind: 'human' as const, id: 'user_1', tenantId: 'tenant_1', displayName: 'Phoebe' },
    body: 'The scope section is ambiguous.',
    createdAt: '2026-06-12T00:00:00.000Z'
  }],
  createdAt: '2026-06-12T00:00:00.000Z',
  updatedAt: '2026-06-12T00:00:00.000Z'
};

describe('run feedback route contracts', () => {
  it('exports the correct feedback path', () => {
    expect(runFeedbackPath).toBe('/v1/runs/:id/feedback');
  });

  it('exports the correct create success status code', () => {
    expect(createRunFeedbackSuccessStatusCode).toBe(201);
  });

  it('exports the correct list success status code', () => {
    expect(listRunFeedbackSuccessStatusCode).toBe(200);
  });

  it('accepts a valid artifact create request', () => {
    const parsed = createRunFeedbackRequestSchema.parse({
      target: 'artifact',
      title: 'Scope unclear',
      body: 'Please clarify.'
    });
    expect(parsed.target).toBe('artifact');
  });

  it('accepts a create request with an optional anchor', () => {
    const parsed = createRunFeedbackRequestSchema.parse({
      target: 'artifact',
      title: 'Title',
      body: 'Body',
      anchor: { kind: 'artifact', artifactId: 'art_1' }
    });
    expect(parsed.anchor).toBeDefined();
  });

  it('rejects a non-artifact target', () => {
    expect(() => createRunFeedbackRequestSchema.parse({
      target: 'implementation',
      title: 'Title',
      body: 'Body'
    })).toThrow();
  });

  it('rejects empty title', () => {
    expect(() => createRunFeedbackRequestSchema.parse({
      target: 'artifact',
      title: '',
      body: 'Body'
    })).toThrow();
  });

  it('rejects empty body', () => {
    expect(() => createRunFeedbackRequestSchema.parse({
      target: 'artifact',
      title: 'Title',
      body: ''
    })).toThrow();
  });

  it('rejects extra fields (strict)', () => {
    expect(() => createRunFeedbackRequestSchema.parse({
      target: 'artifact',
      title: 'Title',
      body: 'Body',
      extraField: true
    })).toThrow();
  });

  it('parses a valid feedback list response', () => {
    const parsed = runFeedbackListResponseSchema.parse({ feedback: [validFeedbackItem] });
    expect(parsed.feedback[0]?.id).toBe('fb_1');
  });

  it('parses an empty feedback list', () => {
    const parsed = runFeedbackListResponseSchema.parse({ feedback: [] });
    expect(parsed.feedback).toHaveLength(0);
  });

  it('rejects extra fields in list response (strict)', () => {
    expect(() => runFeedbackListResponseSchema.parse({
      feedback: [],
      total: 0
    })).toThrow();
  });
});
