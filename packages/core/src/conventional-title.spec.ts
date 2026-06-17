import { describe, expect, it } from 'vitest';
import { deriveConventionalTitle, formatConventionalTitle, getConventionalTitleType, normalizeConventionalSubject } from './conventional-title.js';

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
});
