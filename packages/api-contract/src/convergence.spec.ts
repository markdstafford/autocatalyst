import { describe, expect, it } from 'vitest';

import {
  findingDispositionSchema,
  reviewerFindingSchema,
  reviewerFindingSeveritySchema,
  reviewerResultSchema
} from './convergence.js';

describe('reviewerFindingSeveritySchema', () => {
  it('accepts valid severities', () => {
    expect(reviewerFindingSeveritySchema.parse('blocker')).toBe('blocker');
    expect(reviewerFindingSeveritySchema.parse('warning')).toBe('warning');
    expect(reviewerFindingSeveritySchema.parse('info')).toBe('info');
  });

  it('rejects unknown severities', () => {
    expect(() => reviewerFindingSeveritySchema.parse('critical')).toThrow();
  });
});

describe('reviewerFindingSchema', () => {
  it('accepts a valid finding', () => {
    expect(
      reviewerFindingSchema.parse({ title: 'Missing regression test', body: 'The new branch lacks test coverage.', severity: 'warning' })
    ).toMatchObject({ severity: 'warning' });
  });

  it('rejects empty title', () => {
    expect(() => reviewerFindingSchema.parse({ title: '', body: 'Body', severity: 'warning' })).toThrow();
  });

  it('accepts optional anchor', () => {
    const result = reviewerFindingSchema.parse({
      title: 'Test',
      body: 'Body',
      severity: 'info',
      anchor: { kind: 'artifact', artifactId: 'art_1' }
    });
    expect(result.anchor).toMatchObject({ kind: 'artifact' });
  });
});

describe('reviewerResultSchema', () => {
  it('accepts satisfied result with empty findings array', () => {
    expect(reviewerResultSchema.parse({ status: 'satisfied', findings: [] })).toEqual({ status: 'satisfied', findings: [] });
  });

  it('rejects findings status with empty array', () => {
    expect(() => reviewerResultSchema.parse({ status: 'findings', findings: [] })).toThrow();
  });

  it('accepts findings status with non-empty array', () => {
    const result = reviewerResultSchema.parse({
      status: 'findings',
      findings: [{ title: 'Issue', body: 'Details', severity: 'blocker' }]
    });
    expect(result.status).toBe('findings');
  });
});

describe('findingDispositionSchema', () => {
  it('accepts fixed disposition with summary', () => {
    expect(
      findingDispositionSchema.parse({ feedbackId: 'fb_1', disposition: 'fixed', summary: 'Added the regression test.' })
    ).toMatchObject({ disposition: 'fixed' });
  });

  it('rejects declined disposition with empty reason', () => {
    expect(() => findingDispositionSchema.parse({ feedbackId: 'fb_2', disposition: 'declined', reason: '' })).toThrow();
  });

  it('accepts declined disposition with non-empty reason', () => {
    const result = findingDispositionSchema.parse({ feedbackId: 'fb_3', disposition: 'declined', reason: 'Not applicable.' });
    expect(result.disposition).toBe('declined');
  });
});
