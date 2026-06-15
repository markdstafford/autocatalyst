import { describe, expect, it } from 'vitest';

import {
  convergenceCheckpointSchema,
  convergenceOutcomeSchema,
  convergenceRoundOutcomeSchema,
  convergenceRoundRecordSchema,
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

describe('convergenceRoundOutcomeSchema', () => {
  it('accepts all four round outcomes', () => {
    for (const v of ['continue', 'converged', 'max_rounds', 'oscillation'] as const) {
      expect(convergenceRoundOutcomeSchema.parse(v)).toBe(v);
    }
  });

  it('rejects unknown round outcome', () => {
    expect(() => convergenceRoundOutcomeSchema.parse('done')).toThrow();
  });
});

describe('convergenceOutcomeSchema', () => {
  it('accepts converged, max_rounds, oscillation', () => {
    for (const v of ['converged', 'max_rounds', 'oscillation'] as const) {
      expect(convergenceOutcomeSchema.parse(v)).toBe(v);
    }
  });

  it('rejects continue as a checkpoint outcome', () => {
    expect(() => convergenceOutcomeSchema.parse('continue')).toThrow();
  });
});

describe('convergenceRoundRecordSchema', () => {
  const validRound = {
    round: 1,
    implementerSessionId: 'sess_impl_1',
    reviewerSessionId: 'sess_rev_1',
    implementerCommitSha: 'abc1234',
    changedFileCount: 2,
    findings: [{ feedbackId: 'fb_1', title: 'Missing test', body: 'Add coverage.', severity: 'warning' as const, blocking: true, signature: 'warning:missing-test:hash' }],
    dispositions: [],
    outcome: 'continue' as const
  };

  it('accepts a valid round record with all required fields', () => {
    const result = convergenceRoundRecordSchema.parse(validRound);
    expect(result.round).toBe(1);
    expect(result.outcome).toBe('continue');
  });

  it('rejects round record missing required round field', () => {
    const { round: _omit, ...noRound } = validRound;
    expect(() => convergenceRoundRecordSchema.parse(noRound)).toThrow();
  });
});

describe('convergenceCheckpointSchema', () => {
  const validCheckpoint = {
    kind: 'convergence_review' as const,
    step: 'implementation.build',
    maxRounds: 3,
    routing: { distinct: false, warningCode: 'role_distinct_unsatisfied' as const },
    rounds: [{
      round: 1,
      implementerSessionId: 'sess_impl_1',
      reviewerSessionId: 'sess_rev_1',
      implementerCommitSha: 'abc1234',
      changedFileCount: 2,
      findings: [{ feedbackId: 'fb_1', title: 'Missing test', body: 'Add coverage.', severity: 'warning' as const, blocking: true, signature: 'warning:missing-test:hash' }],
      dispositions: [],
      outcome: 'continue' as const
    }],
    outcome: 'max_rounds' as const,
    openFeedbackIds: ['fb_1'],
    lastPositions: { implementer: 'Fixed one issue.', reviewer: 'Still blocked.' }
  };

  it('accepts a valid checkpoint', () => {
    const result = convergenceCheckpointSchema.parse(validCheckpoint);
    expect(result.kind).toBe('convergence_review');
    expect(result.outcome).toBe('max_rounds');
  });

  it('rejects checkpoint with invalid outcome value', () => {
    expect(() => convergenceCheckpointSchema.parse({ ...validCheckpoint, outcome: 'continue' })).toThrow();
  });
});
