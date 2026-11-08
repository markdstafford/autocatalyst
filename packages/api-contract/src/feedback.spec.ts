import { describe, expect, it } from 'vitest';

import {
  runFeedbackPath,
  createRunFeedbackSuccessStatusCode,
  listRunFeedbackSuccessStatusCode,
  createRunFeedbackRequestSchema,
  runFeedbackListResponseSchema,
  feedbackResponseSchema,
  feedbackSchema,
  updateRunFeedbackPath,
  updateRunFeedbackSuccessStatusCode,
  updateRunFeedbackRequestSchema
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

const anchoredItem = (anchor: unknown) => ({
  ...validFeedbackItem,
  anchor
});

describe('feedback response stale anchor', () => {
  it('accepts an artifact_range response anchor with stale: true', () => {
    const parsed = feedbackResponseSchema.parse(anchoredItem({
      kind: 'artifact_range',
      artifactId: 'art_1',
      from: 0,
      to: 5,
      quotedText: 'Scope',
      stale: true
    }));
    expect(parsed.anchor).toMatchObject({ stale: true });
  });

  it('accepts a fresh artifact_range response anchor with no stale key', () => {
    const parsed = feedbackResponseSchema.parse(anchoredItem({
      kind: 'artifact_range',
      artifactId: 'art_1',
      from: 0,
      to: 5,
      quotedText: 'Scope'
    }));
    expect(parsed.anchor && 'stale' in parsed.anchor).toBe(false);
  });

  it('rejects stale: false in a response anchor', () => {
    expect(() => feedbackResponseSchema.parse(anchoredItem({
      kind: 'artifact_range',
      artifactId: 'art_1',
      from: 0,
      to: 5,
      quotedText: 'Scope',
      stale: false
    }))).toThrow();
  });

  it('rejects a stale key on the stored feedback schema', () => {
    expect(() => feedbackSchema.parse(anchoredItem({
      kind: 'artifact_range',
      artifactId: 'art_1',
      from: 0,
      to: 5,
      quotedText: 'Scope',
      stale: true
    }))).toThrow();
  });

  it('rejects a list response item carrying a stored stale key (list uses response schema but rejects stale:false)', () => {
    // Reconciliation only ever emits stale: true; stale: false must never appear on the wire.
    expect(() => runFeedbackListResponseSchema.parse({ feedback: [anchoredItem({
      kind: 'artifact_range', artifactId: 'art_1', from: 0, to: 5, quotedText: 'Scope', stale: false
    })] })).toThrow();
  });
});

describe('updateRunFeedbackRequestSchema', () => {
  it('exports the PATCH path and success code', () => {
    expect(updateRunFeedbackPath).toBe('/v1/runs/:id/feedback/:feedbackId');
    expect(updateRunFeedbackSuccessStatusCode).toBe(200);
  });

  it('accepts status resolved with no body', () => {
    expect(updateRunFeedbackRequestSchema.parse({ status: 'resolved' }).status).toBe('resolved');
  });

  it('accepts status resolved with a body', () => {
    expect(updateRunFeedbackRequestSchema.parse({ status: 'resolved', body: 'Looks good.' }).body).toBe('Looks good.');
  });

  it('accepts status open with a body', () => {
    expect(updateRunFeedbackRequestSchema.parse({ status: 'open', body: 'Still broken.' }).status).toBe('open');
  });

  it('rejects an unknown status', () => {
    expect(() => updateRunFeedbackRequestSchema.parse({ status: 'addressed' })).toThrow();
  });

  it('rejects extra fields (strict)', () => {
    expect(() => updateRunFeedbackRequestSchema.parse({ status: 'resolved', extra: 1 })).toThrow();
  });

  it('rejects an empty body', () => {
    expect(() => updateRunFeedbackRequestSchema.parse({ status: 'open', body: '' })).toThrow();
  });
});
