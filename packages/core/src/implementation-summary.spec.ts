import { describe, expect, it } from 'vitest';
import {
  MissingCumulativeImplementationSummaryError,
  buildCumulativeImplementationSummary,
  isCumulativeImplementationSummary,
  requireCumulativeImplementationSummary
} from './implementation-summary.js';

describe('buildCumulativeImplementationSummary', () => {
  it('folds two rounds preserving both changes', () => {
    const summary = buildCumulativeImplementationSummary({
      rounds: [
        {
          fixSummary: 'Added project import flow.',
          changedFiles: ['packages/core/src/import.ts'],
          validation: ['pnpm nx test core'],
          followUps: []
        },
        {
          fixSummary: 'Fixed expired tracker token handling.',
          changedFiles: ['packages/core/src/auth.ts'],
          validation: ['pnpm nx test core -- --run auth.spec.ts'],
          followUps: ['Live provider smoke remains opt-in.']
        }
      ],
      completedAt: '2026-06-17T00:00:00.000Z'
    });

    expect(summary.cumulativeSummary).toContain('Added project import flow');
    expect(summary.cumulativeSummary).toContain('Fixed expired tracker token handling');
    expect(summary.changedFiles).toEqual(['packages/core/src/auth.ts', 'packages/core/src/import.ts']);
    expect(summary.sourceRoundCount).toBe(2);
    expect(summary.followUps).toContain('Live provider smoke remains opt-in.');
    expect(summary.validationSummary).toContain('pnpm nx test core');
    expect(summary.validationSummary).toContain('pnpm nx test core -- --run auth.spec.ts');
  });

  it('deduplicates changed files and validation across rounds', () => {
    const summary = buildCumulativeImplementationSummary({
      rounds: [
        { changedFiles: ['packages/core/src/a.ts'], validation: ['pnpm nx test core'] },
        { changedFiles: ['packages/core/src/a.ts'], validation: ['pnpm nx test core'] }
      ],
      completedAt: '2026-06-17T00:00:00.000Z'
    });

    expect(summary.changedFiles).toEqual(['packages/core/src/a.ts']);
    expect(summary.validationSummary).toEqual(['pnpm nx test core']);
  });

  it('throws for empty rounds', () => {
    expect(() => buildCumulativeImplementationSummary({ rounds: [], completedAt: '2026-06-17T00:00:00.000Z' }))
      .toThrow(MissingCumulativeImplementationSummaryError);
  });

  it('sets kind to cumulative_implementation_summary', () => {
    const summary = buildCumulativeImplementationSummary({
      rounds: [{ fixSummary: 'Something.' }],
      completedAt: '2026-06-17T00:00:00.000Z'
    });
    expect(summary.kind).toBe('cumulative_implementation_summary');
  });

  it('handles rounds with no fixSummary gracefully', () => {
    const summary = buildCumulativeImplementationSummary({
      rounds: [
        { changedFiles: ['a.ts'] },
        { fixSummary: 'Fixed something.' }
      ],
      completedAt: '2026-06-17T00:00:00.000Z'
    });
    expect(summary.cumulativeSummary).toBe('Fixed something.');
    expect(summary.changedFiles).toContain('a.ts');
  });
});

describe('isCumulativeImplementationSummary', () => {
  it('returns true for valid summaries', () => {
    const summary = buildCumulativeImplementationSummary({
      rounds: [{ fixSummary: 'Done.' }],
      completedAt: '2026-06-17T00:00:00.000Z'
    });
    expect(isCumulativeImplementationSummary(summary)).toBe(true);
  });

  it('returns false for non-summary objects', () => {
    expect(isCumulativeImplementationSummary({ kind: 'other' })).toBe(false);
    expect(isCumulativeImplementationSummary(null)).toBe(false);
    expect(isCumulativeImplementationSummary('string')).toBe(false);
  });
});

describe('requireCumulativeImplementationSummary', () => {
  it('returns the summary when valid', () => {
    const summary = buildCumulativeImplementationSummary({
      rounds: [{ fixSummary: 'Done.' }],
      completedAt: '2026-06-17T00:00:00.000Z'
    });
    expect(requireCumulativeImplementationSummary(summary)).toBe(summary);
  });

  it('throws MissingCumulativeImplementationSummaryError for invalid input', () => {
    expect(() => requireCumulativeImplementationSummary(null)).toThrow(MissingCumulativeImplementationSummaryError);
    expect(() => requireCumulativeImplementationSummary({ kind: 'other' })).toThrow(MissingCumulativeImplementationSummaryError);
  });
});
