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
});
