import { describe, expect, it } from 'vitest';

import {
  altitudeCheckpointRefSchema,
  convergenceCheckpointSchema,
  convergenceFindingCategorySchema,
  convergenceFindingSourceSchema,
  convergenceOutcomeSchema,
  convergenceRoundFindingSchema,
  convergenceRoundOutcomeSchema,
  convergenceRoundRecordSchema,
  findingDispositionSchema,
  implementationAltitudeSchema,
  implementationConvergenceDepthSchema,
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

  it('accepts checkpoint with depth, currentAltitude, and acceptedCheckpoints', () => {
    const result = convergenceCheckpointSchema.parse({
      ...validCheckpoint,
      depth: 'full' as const,
      currentAltitude: 'public_api' as const,
      acceptedCheckpoints: [
        { altitude: 'layout' as const, ref: 'layout-ref-1', commitSha: 'sha1', acceptedAt: '2026-06-15T12:00:00.000Z' }
      ]
    });
    expect(result.depth).toBe('full');
    expect(result.currentAltitude).toBe('public_api');
    expect(result.acceptedCheckpoints?.[0]?.altitude).toBe('layout');
  });

  it('rejects acceptedCheckpoints with build altitude', () => {
    expect(() => convergenceCheckpointSchema.parse({
      ...validCheckpoint,
      acceptedCheckpoints: [
        { altitude: 'build', ref: 'r', commitSha: 's', acceptedAt: '2026-06-15T12:00:00.000Z' }
      ]
    })).toThrow();
  });
});

describe('implementationAltitudeSchema', () => {
  it('accepts the four altitudes', () => {
    for (const v of ['layout', 'public_api', 'private_api', 'build'] as const) {
      expect(implementationAltitudeSchema.parse(v)).toBe(v);
    }
  });

  it('rejects unknown altitudes', () => {
    expect(() => implementationAltitudeSchema.parse('runtime')).toThrow();
  });
});

describe('implementationConvergenceDepthSchema', () => {
  it('accepts the four depths', () => {
    for (const v of ['build_only', 'layout', 'public_api', 'full'] as const) {
      expect(implementationConvergenceDepthSchema.parse(v)).toBe(v);
    }
  });

  it('rejects unknown depths', () => {
    expect(() => implementationConvergenceDepthSchema.parse('deep')).toThrow();
  });
});

describe('convergenceFindingSourceSchema', () => {
  it('accepts known sources', () => {
    for (const v of ['reviewer', 'altitude_contract', 'build_drift'] as const) {
      expect(convergenceFindingSourceSchema.parse(v)).toBe(v);
    }
  });
});

describe('convergenceFindingCategorySchema', () => {
  it('accepts known categories', () => {
    for (const v of ['layout', 'public_api', 'private_api', 'build', 'contract_violation', 'build_drift'] as const) {
      expect(convergenceFindingCategorySchema.parse(v)).toBe(v);
    }
  });
});

describe('altitudeCheckpointRefSchema', () => {
  it('accepts a valid checkpoint ref', () => {
    const ref = altitudeCheckpointRefSchema.parse({
      altitude: 'layout' as const,
      ref: 'r',
      commitSha: 's',
      acceptedAt: '2026-06-15T12:00:00.000Z'
    });
    expect(ref.altitude).toBe('layout');
  });

  it('rejects build altitude in a checkpoint ref', () => {
    expect(() => altitudeCheckpointRefSchema.parse({
      altitude: 'build',
      ref: 'r',
      commitSha: 's',
      acceptedAt: '2026-06-15T12:00:00.000Z'
    })).toThrow();
  });
});

describe('convergenceRoundFindingSchema with altitude metadata', () => {
  const base = {
    feedbackId: 'fb_1',
    title: 'Layout violation',
    body: 'symbol exposed at wrong layer',
    severity: 'blocker' as const,
    blocking: true,
    signature: 'sig'
  };

  it('accepts optional altitude metadata', () => {
    const result = convergenceRoundFindingSchema.parse({
      ...base,
      source: 'altitude_contract' as const,
      altitude: 'layout' as const,
      category: 'public_api' as const,
      blockingReason: 'Public API drift',
      deterministicKey: 'k1',
      sourcePath: 'src/foo.ts',
      symbolName: 'doStuff',
      acceptedCheckpoint: { altitude: 'layout' as const, ref: 'r', commitSha: 's' }
    });
    expect(result.source).toBe('altitude_contract');
    expect(result.altitude).toBe('layout');
  });

  it('accepts a finding without altitude metadata (legacy)', () => {
    expect(() => convergenceRoundFindingSchema.parse(base)).not.toThrow();
  });
});

describe('convergenceRoundRecordSchema altitude defaulting', () => {
  const baseRound = {
    round: 1,
    changedFileCount: 0,
    findings: [],
    dispositions: [],
    outcome: 'continue' as const
  };

  it('defaults altitude to build when absent (migration tolerance)', () => {
    const r = convergenceRoundRecordSchema.parse(baseRound);
    expect(r.altitude).toBe('build');
  });

  it('preserves explicit altitude', () => {
    const r = convergenceRoundRecordSchema.parse({ ...baseRound, altitude: 'layout' });
    expect(r.altitude).toBe('layout');
  });

  it('rejects an invalid altitude value', () => {
    expect(() => convergenceRoundRecordSchema.parse({ ...baseRound, altitude: 'mid_air' })).toThrow();
  });
});

describe('convergenceRoundRecordSchema changedFilePaths', () => {
  it('defaults missing changedFilePaths on legacy convergence rounds', () => {
    const parsed = convergenceRoundRecordSchema.parse({
      round: 1,
      changedFileCount: 2,
      findings: [],
      dispositions: [],
      outcome: 'converged'
    });

    expect(parsed.altitude).toBe('build');
    expect(parsed.changedFilePaths).toEqual([]);
  });

  it('accepts readonly changedFilePaths on convergence rounds', () => {
    const parsed = convergenceRoundRecordSchema.parse({
      round: 1,
      changedFileCount: 2,
      changedFilePaths: ['packages/core/src/orchestrator.ts', 'packages/core/src/pr-content.ts'],
      findings: [],
      dispositions: [],
      outcome: 'converged',
      altitude: 'build'
    });

    expect(parsed.changedFilePaths).toEqual([
      'packages/core/src/orchestrator.ts',
      'packages/core/src/pr-content.ts'
    ]);
  });

  it('reports invalid changedFilePaths entries at the nested entry path', () => {
    const result = convergenceRoundRecordSchema.safeParse({
      round: 1,
      changedFileCount: 1,
      changedFilePaths: [''],
      findings: [],
      dispositions: [],
      outcome: 'converged',
      altitude: 'build'
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['changedFilePaths', 0]);
    }
  });
});
