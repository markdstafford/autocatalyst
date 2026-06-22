import { describe, expect, it } from 'vitest';
import { deriveChangedPathSubject, deriveConventionalTitle, formatConventionalTitle, getConventionalTitleType, normalizeConventionalSubject } from './conventional-title.js';

describe('getConventionalTitleType', () => {
  it('maps feature and enhancement to feat', () => {
    expect(getConventionalTitleType('feature')).toBe('feat');
    expect(getConventionalTitleType('enhancement')).toBe('feat');
  });

  it('maps bug to fix', () => {
    expect(getConventionalTitleType('bug')).toBe('fix');
  });

  it('maps chore to chore', () => {
    expect(getConventionalTitleType('chore')).toBe('chore');
  });

  it('returns null for file_issue and question', () => {
    expect(getConventionalTitleType('file_issue')).toBeNull();
    expect(getConventionalTitleType('question')).toBeNull();
  });

  it('returns null for unknown work kinds', () => {
    expect(getConventionalTitleType('unknown')).toBeNull();
  });
});

describe('normalizeConventionalSubject', () => {
  it('strips trailing period', () => {
    expect(normalizeConventionalSubject('Add project import.')).toBe('add project import');
  });

  it('strips Markdown heading marker', () => {
    expect(normalizeConventionalSubject('# Add project import')).toBe('add project import');
  });

  it('strips list markers', () => {
    expect(normalizeConventionalSubject('- Handle expired tracker tokens.')).toBe('handle expired tracker tokens');
  });

  it('lowercases only the first ASCII letter', () => {
    expect(normalizeConventionalSubject('Refresh workspace cleanup')).toBe('refresh workspace cleanup');
  });

  it('does not lowercase subsequent uppercase letters', () => {
    expect(normalizeConventionalSubject('Update README file')).toBe('update README file');
  });

  it('collapses internal whitespace', () => {
    expect(normalizeConventionalSubject('Add  multiple   spaces')).toBe('add multiple spaces');
  });

  it('removes line breaks', () => {
    expect(normalizeConventionalSubject('Add\nproject\nimport')).toBe('add project import');
  });

  it('truncates at 72 chars without cutting a word', () => {
    const long = 'A very long subject that exceeds seventy-two characters in total length here end';
    const result = normalizeConventionalSubject(long);
    expect(result.length).toBeLessThanOrEqual(72);
    // Should not end with partial word
    expect(result).not.toMatch(/\S-$/u);
  });
});

describe('formatConventionalTitle', () => {
  it('formats feat: add project import', () => {
    expect(formatConventionalTitle('feat', 'Add project import.')).toBe('feat: add project import');
  });

  it('formats fix: handle expired tracker tokens', () => {
    expect(formatConventionalTitle('fix', '- Handle expired tracker tokens.')).toBe('fix: handle expired tracker tokens');
  });

  it('formats chore: refresh workspace cleanup', () => {
    expect(formatConventionalTitle('chore', 'Refresh workspace cleanup')).toBe('chore: refresh workspace cleanup');
  });
});

describe('deriveConventionalTitle', () => {
  it('uses titleSubject when present', () => {
    expect(deriveConventionalTitle({ workKind: 'feature', titleSubject: 'Add project import.' })).toBe('feat: add project import');
  });

  it('strips heading from titleSubject', () => {
    expect(deriveConventionalTitle({ workKind: 'enhancement', titleSubject: '# Add project import' })).toBe('feat: add project import');
  });

  it('strips list marker from titleSubject for bug', () => {
    expect(deriveConventionalTitle({ workKind: 'bug', titleSubject: '- Handle expired tracker tokens.' })).toBe('fix: handle expired tracker tokens');
  });

  it('formats chore correctly', () => {
    expect(deriveConventionalTitle({ workKind: 'chore', titleSubject: 'Refresh workspace cleanup' })).toBe('chore: refresh workspace cleanup');
  });

  it('returns null for question work kind', () => {
    expect(deriveConventionalTitle({ workKind: 'question', titleSubject: 'Explain behavior' })).toBeNull();
  });

  it('returns null for file_issue work kind', () => {
    expect(deriveConventionalTitle({ workKind: 'file_issue', titleSubject: 'File issue' })).toBeNull();
  });

  it('falls back to reconciledSummary when titleSubject absent', () => {
    const result = deriveConventionalTitle({
      workKind: 'feature',
      reconciledSummary: 'Add project import flow.\n\nDetailed description.'
    });
    expect(result).toBe('feat: add project import flow');
  });

  it('falls back to cumulativeSummary when titleSubject and reconciledSummary absent', () => {
    const result = deriveConventionalTitle({
      workKind: 'bug',
      cumulativeSummary: 'Handle expired tracker tokens.\n\nMore details.'
    });
    expect(result).toBe('fix: handle expired tracker tokens');
  });

  it('falls back to complete approved implementation when all sources empty', () => {
    const result = deriveConventionalTitle({ workKind: 'feature' });
    expect(result).toBe('feat: complete approved implementation');
  });

  it('falls back to complete approved implementation on chore with no summary', () => {
    const result = deriveConventionalTitle({ workKind: 'chore', titleSubject: '' });
    expect(result).toBe('chore: complete approved implementation');
  });

  it('derives changed-path subject when final review and cumulative summary are absent', () => {
    expect(deriveConventionalTitle({
      workKind: 'enhancement',
      changedFiles: ['packages/core/src/pr-open-handler.ts', 'packages/core/src/pr-content.ts']
    })).toBe('feat: update core PR content handling');
  });

  it('keeps titleSubject and reconciledSummary precedence over changed paths', () => {
    expect(deriveConventionalTitle({
      workKind: 'enhancement',
      titleSubject: 'preserve final review title',
      reconciledSummary: 'Use reconciled summary.',
      cumulativeSummary: '',
      changedFiles: ['packages/core/src/pr-open-handler.ts']
    })).toBe('feat: preserve final review title');

    expect(deriveConventionalTitle({
      workKind: 'enhancement',
      reconciledSummary: 'Use reconciled summary.',
      cumulativeSummary: '',
      changedFiles: ['packages/core/src/pr-open-handler.ts']
    })).toBe('feat: use reconciled summary');
  });

  it('falls back to generic subject when no summary or changed paths exist', () => {
    expect(deriveConventionalTitle({ workKind: 'enhancement', cumulativeSummary: '', changedFiles: [] }))
      .toBe('feat: complete approved implementation');
  });

  it('prefers real cumulative summary over changed-path fallback', () => {
    expect(deriveConventionalTitle({
      workKind: 'enhancement',
      cumulativeSummary: 'Preserves real implementation change text.',
      changedFiles: ['packages/core/src/pr-content.ts']
    })).toBe('feat: preserves real implementation change text');
  });

  it('does not produce count-only or round placeholder titles', () => {
    const title = deriveConventionalTitle({
      workKind: 'enhancement',
      cumulativeSummary: '',
      changedFiles: ['packages/core/src/orchestrator.ts']
    });

    expect(title).not.toMatch(/round \d+/iu);
    expect(title).not.toContain('implementation passed review');
    expect(title).not.toContain('file(s) changed');
  });

  it('does not use "Round N: implementation passed review" as the title subject', () => {
    // This text was previously synthesized by orchestrator.ts for clean rounds;
    // old checkpoints may still contain it. It must not appear in the PR title.
    const title = deriveConventionalTitle({
      workKind: 'feature',
      cumulativeSummary: 'Round 1: implementation passed review',
      changedFiles: ['packages/core/src/orchestrator.ts']
    });

    expect(title).not.toMatch(/implementation passed review/iu);
    expect(title).not.toMatch(/round \d+/iu);
  });

  describe('fallback order regression', () => {
    it('1. titleSubject takes priority over all other sources', () => {
      expect(deriveConventionalTitle({
        workKind: 'enhancement',
        titleSubject: 'Durable activity API',
        reconciledSummary: 'Wrong.',
        cumulativeSummary: 'Wrong.',
        changedFiles: ['packages/core/src/routes.ts']
      })).toBe('feat: durable activity API');
    });

    it('2. reconciledSummary used when no titleSubject', () => {
      expect(deriveConventionalTitle({
        workKind: 'enhancement',
        reconciledSummary: 'Expose durable run sessions.',
        cumulativeSummary: 'Wrong.',
        changedFiles: ['packages/core/src/routes.ts']
      })).toBe('feat: expose durable run sessions');
    });

    it('3. cumulativeSummary used when no titleSubject or reconciledSummary', () => {
      expect(deriveConventionalTitle({
        workKind: 'enhancement',
        cumulativeSummary: 'Persist sessions for completed runs.',
        changedFiles: ['packages/core/src/routes.ts']
      })).toBe('feat: persist sessions for completed runs');
    });

    it('4. Round N placeholder in cumulativeSummary falls back to changed-path-derived subject', () => {
      expect(deriveConventionalTitle({
        workKind: 'enhancement',
        cumulativeSummary: 'Round 1: implementation passed review',
        changedFiles: ['packages/core/src/pr-content.ts', 'packages/core/src/pr-open-handler.ts']
      })).toBe('feat: update core PR content handling');
    });

    it('5. No files with placeholder summary falls back to generic subject', () => {
      expect(deriveConventionalTitle({
        workKind: 'enhancement',
        cumulativeSummary: 'Round 1: implementation passed review',
        changedFiles: []
      })).toBe('feat: complete approved implementation');
    });
  });
});

describe('deriveChangedPathSubject', () => {
  it('returns null for empty array', () => {
    expect(deriveChangedPathSubject([])).toBeNull();
  });

  it('returns single-file subject for one file', () => {
    expect(deriveChangedPathSubject(['packages/core/src/foo.ts'])).toBe('update packages/core/src/foo.ts');
  });

  it('returns package-specific PR subject when paths include pr- filenames', () => {
    expect(deriveChangedPathSubject(['packages/core/src/pr-open-handler.ts', 'packages/core/src/pr-content.ts']))
      .toBe('update core PR content handling');
  });

  it('returns package-scoped subject for non-PR files in single package', () => {
    expect(deriveChangedPathSubject(['packages/core/src/foo.ts', 'packages/core/src/bar.ts']))
      .toBe('update core package changes');
  });

  it('returns top-level joined subject for two top-level dirs', () => {
    expect(deriveChangedPathSubject(['packages/core/src/foo.ts', 'scripts/build.sh']))
      .toBe('update packages and scripts changes');
  });

  it('returns generic subject for many top-level dirs', () => {
    expect(deriveChangedPathSubject(['a/foo.ts', 'b/bar.ts', 'c/baz.ts']))
      .toBe('update changed implementation files');
  });
});
