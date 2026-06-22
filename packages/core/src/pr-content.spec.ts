import { describe, expect, it } from 'vitest';
import { buildCumulativeImplementationSummary, MissingCumulativeImplementationSummaryError } from './implementation-summary.js';
import { buildPullRequestContent } from './pr-content.js';

const baseSummary = buildCumulativeImplementationSummary({
  rounds: [
    {
      fixSummary: 'Added project import flow.',
      changedFiles: ['packages/core/src/import.ts'],
      validation: ['pnpm nx test core'],
      followUps: ['Live provider smoke remains opt-in.']
    }
  ],
  completedAt: '2026-06-17T00:00:00.000Z'
});

describe('buildPullRequestContent', () => {
  it('produces conventional-commit title for feature', () => {
    const content = buildPullRequestContent({
      workKind: 'feature',
      cumulativeSummary: baseSummary,
      titleSubject: 'Add project import.'
    });
    expect(content.title).toBe('feat: add project import');
  });

  it('includes summary text in body', () => {
    const content = buildPullRequestContent({
      workKind: 'feature',
      cumulativeSummary: baseSummary,
      titleSubject: 'Add project import.'
    });
    expect(content.body).toContain('## Summary');
    expect(content.body).toContain('Added project import flow');
  });

  it('includes issue URL when present', () => {
    const content = buildPullRequestContent({
      workKind: 'feature',
      cumulativeSummary: baseSummary,
      issueUrl: 'https://github.com/owner/repo/issues/73',
      titleSubject: 'Add project import.'
    });
    expect(content.body).toContain('https://github.com/owner/repo/issues/73');
  });

  it('includes validation section', () => {
    const content = buildPullRequestContent({
      workKind: 'feature',
      cumulativeSummary: baseSummary,
      titleSubject: 'Add project import.'
    });
    expect(content.body).toContain('## Validation');
    expect(content.body).toContain('pnpm nx test core');
  });

  it('includes follow-ups', () => {
    const content = buildPullRequestContent({
      workKind: 'feature',
      cumulativeSummary: baseSummary,
      titleSubject: 'Add project import.'
    });
    expect(content.body).toContain('Live provider smoke remains opt-in.');
  });

  it('does not expose internal scratch paths', () => {
    const content = buildPullRequestContent({
      workKind: 'feature',
      cumulativeSummary: baseSummary,
      titleSubject: 'Add project import.'
    });
    expect(content.body).not.toContain('/Users/');
    expect(content.body).not.toContain('/tmp/');
  });

  it('uses reconciledSummary over cumulativeSummary for body', () => {
    const content = buildPullRequestContent({
      workKind: 'feature',
      cumulativeSummary: baseSummary,
      reconciledSummary: 'Reconciled version of the change.',
      titleSubject: 'Add project import.'
    });
    expect(content.body).toContain('Reconciled version of the change.');
  });

  it('uses fix work kind correctly', () => {
    const bugSummary = buildCumulativeImplementationSummary({
      rounds: [{ fixSummary: 'Handle expired tracker tokens.' }],
      completedAt: '2026-06-17T00:00:00.000Z'
    });
    const content = buildPullRequestContent({
      workKind: 'bug',
      cumulativeSummary: bugSummary,
      titleSubject: 'Handle expired tracker tokens.'
    });
    expect(content.title).toBe('fix: handle expired tracker tokens');
  });

  it('throws for unsupported work kind', () => {
    expect(() => buildPullRequestContent({
      workKind: 'question',
      cumulativeSummary: baseSummary,
      titleSubject: 'Something.'
    })).toThrow();
  });

  it('throws MissingCumulativeImplementationSummaryError when cumulativeSummary is falsy', () => {
    expect(() => buildPullRequestContent({
      workKind: 'feature',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cumulativeSummary: null as any,
      titleSubject: 'Add project import.'
    })).toThrow(MissingCumulativeImplementationSummaryError);
  });

  it('renders real changed paths and filters legacy count-only placeholders', () => {
    const content = buildPullRequestContent({
      workKind: 'enhancement',
      cumulativeSummary: {
        kind: 'cumulative_implementation_summary',
        cumulativeSummary: 'Updates PR content fallback.',
        changedFiles: [
          'round 1: 3 file(s) changed',
          '3 file(s) changed',
          'packages/core/src/pr-content.ts'
        ],
        validationSummary: [],
        followUps: [],
        nonGoals: [],
        sourceRoundCount: 1,
        completedAt: '2026-06-18T00:00:00.000Z'
      }
    });

    expect(content.body).toContain('- `packages/core/src/pr-content.ts`');
    expect(content.body).not.toContain('round 1: 3 file(s) changed');
    expect(content.body).not.toContain('3 file(s) changed');
  });

  it('passes changed files into title fallback when summary text is empty', () => {
    const content = buildPullRequestContent({
      workKind: 'enhancement',
      cumulativeSummary: {
        kind: 'cumulative_implementation_summary',
        cumulativeSummary: '',
        changedFiles: ['packages/core/src/pr-open-handler.ts'],
        validationSummary: [],
        followUps: [],
        nonGoals: [],
        sourceRoundCount: 1,
        completedAt: '2026-06-18T00:00:00.000Z'
      }
    });

    expect(content.title).toBe('feat: update packages/core/src/pr-open-handler.ts');
    expect(content.body).not.toMatch(/round \d+/iu);
    expect(content.body).not.toContain('implementation passed review');
    expect(content.body).not.toContain('file(s) changed');
  });

  it('uses reconciled summary for body while keeping real changed files', () => {
    const content = buildPullRequestContent({
      workKind: 'enhancement',
      reconciledSummary: 'Reviewer-refined summary.',
      cumulativeSummary: {
        kind: 'cumulative_implementation_summary',
        cumulativeSummary: 'Fallback summary.',
        changedFiles: ['packages/core/src/pr-content.ts'],
        validationSummary: [],
        followUps: [],
        nonGoals: [],
        sourceRoundCount: 1,
        completedAt: '2026-06-18T00:00:00.000Z'
      }
    });

    expect(content.body).toContain('Reviewer-refined summary.');
    expect(content.body).not.toContain('Fallback summary.');
    expect(content.body).toContain('- `packages/core/src/pr-content.ts`');
  });

  it('produces useful title and renders real changed paths when finalization output is empty', () => {
    // Simulates pr.finalize returning {} (empty output): no titleSubject, no reconciledSummary,
    // cumulativeSummary contains a legacy placeholder. Must still produce a meaningful title
    // and must include repository-relative changed paths in the body.
    const content = buildPullRequestContent({
      workKind: 'enhancement',
      titleSubject: null,
      reconciledSummary: null,
      cumulativeSummary: {
        kind: 'cumulative_implementation_summary',
        cumulativeSummary: 'Round 1: implementation passed review',
        changedFiles: [
          'packages/core/src/routes.ts',
          'packages/sdk/src/client.ts'
        ],
        validationSummary: [],
        followUps: [],
        nonGoals: [],
        sourceRoundCount: 1,
        completedAt: '2026-06-18T00:00:00.000Z'
      }
    });

    // Title must NOT be a count-only or round-placeholder value
    expect(content.title).not.toMatch(/\d+ file\(s\) changed/iu);
    expect(content.title).not.toMatch(/round \d+: implementation passed review/iu);
    // Body must contain repository-relative changed paths
    expect(content.body).toContain('- `packages/core/src/routes.ts`');
    expect(content.body).toContain('- `packages/sdk/src/client.ts`');
  });
});
