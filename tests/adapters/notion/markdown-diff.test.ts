// tests/adapters/notion/markdown-diff.test.ts
import { describe, it, expect } from 'vitest';
import {
  stripCommentSpans,
  extractCommentSpans,
  ensureSpansPreserved,
  prettifyMarkdown,
  stripAllHtml,
} from '../../../src/adapters/notion/markdown-diff.js';

// ─── stripCommentSpans ──────────────────────────────────────────────────

describe('stripCommentSpans', () => {
  it('returns unchanged text when no spans present', () => {
    const input = '# Hello\n\nSome paragraph text.';
    expect(stripCommentSpans(input)).toBe(input);
  });

  it('strips a single span, preserving inner text', () => {
    const input = 'Before <span discussion-urls="discussion://abc123">commented text</span> after.';
    expect(stripCommentSpans(input)).toBe('Before commented text after.');
  });

  it('strips multiple spans in the same line', () => {
    const input = '<span discussion-urls="discussion://a">one</span> and <span discussion-urls="discussion://b">two</span>';
    expect(stripCommentSpans(input)).toBe('one and two');
  });

  it('strips spans across multiple lines', () => {
    const input = 'Line 1 <span discussion-urls="discussion://a">word</span>\nLine 2 <span discussion-urls="discussion://b">other</span>';
    expect(stripCommentSpans(input)).toBe('Line 1 word\nLine 2 other');
  });

  it('handles span with extra attributes', () => {
    const input = '<span discussion-urls="discussion://abc" data-other="x">text</span>';
    expect(stripCommentSpans(input)).toBe('text');
  });

  it('returns empty string for empty input', () => {
    expect(stripCommentSpans('')).toBe('');
  });

  it('preserves non-comment span tags', () => {
    const input = '<span class="highlight">text</span>';
    expect(stripCommentSpans(input)).toBe('<span class="highlight">text</span>');
  });
});

// ─── extractCommentSpans ────────────────────────────────────────────────

describe('extractCommentSpans', () => {
  it('returns empty array when no spans present', () => {
    expect(extractCommentSpans('# Hello\n\nParagraph text.')).toEqual([]);
  });

  it('extracts a single span with uuid and inner_text', () => {
    const input = 'Before <span discussion-urls="discussion://abc-123">commented text</span> after.';
    expect(extractCommentSpans(input)).toEqual([
      { uuid: 'discussion://abc-123', inner_text: 'commented text' },
    ]);
  });

  it('extracts multiple spans in document order', () => {
    const input = '<span discussion-urls="discussion://a">first</span> then <span discussion-urls="discussion://b">second</span>';
    expect(extractCommentSpans(input)).toEqual([
      { uuid: 'discussion://a', inner_text: 'first' },
      { uuid: 'discussion://b', inner_text: 'second' },
    ]);
  });

  it('extracts span with extra attributes', () => {
    const input = '<span data-other="x" discussion-urls="discussion://abc" class="y">text</span>';
    expect(extractCommentSpans(input)).toEqual([
      { uuid: 'discussion://abc', inner_text: 'text' },
    ]);
  });

  it('handles empty inner text', () => {
    const input = '<span discussion-urls="discussion://abc"></span>';
    expect(extractCommentSpans(input)).toEqual([
      { uuid: 'discussion://abc', inner_text: '' },
    ]);
  });

  it('returns empty array for empty input', () => {
    expect(extractCommentSpans('')).toEqual([]);
  });

  it('ignores non-comment spans', () => {
    const input = '<span class="highlight">text</span>';
    expect(extractCommentSpans(input)).toEqual([]);
  });
});

// ─── ensureSpansPreserved ───────────────────────────────────────────────

describe('ensureSpansPreserved', () => {
  it('returns content unchanged when all spans present', () => {
    const content = '# Spec\n\n<span discussion-urls="discussion://abc">text</span> here.';
    const spans = [{ uuid: 'discussion://abc', inner_text: 'text' }];
    expect(ensureSpansPreserved(content, spans)).toBe(content);
  });

  it('returns content unchanged when originalSpans is empty', () => {
    const content = '# Spec\n\nNo spans here.';
    expect(ensureSpansPreserved(content, [])).toBe(content);
  });

  it('appends missing span to new Orphaned comments section', () => {
    const content = '# Spec\n\nRevised content.';
    const spans = [{ uuid: 'discussion://abc-123', inner_text: 'original text' }];
    const result = ensureSpansPreserved(content, spans);
    expect(result).toContain('## Orphaned comments');
    expect(result).toContain('<span discussion-urls="discussion://abc-123">original text</span>');
    expect(result).toContain('[dropped by Claude]');
  });

  it('appends multiple missing spans', () => {
    const content = '# Spec\n\nRevised.';
    const spans = [
      { uuid: 'discussion://a', inner_text: 'first' },
      { uuid: 'discussion://b', inner_text: 'second' },
    ];
    const result = ensureSpansPreserved(content, spans);
    expect(result).toContain('<span discussion-urls="discussion://a">first</span> [dropped by Claude]');
    expect(result).toContain('<span discussion-urls="discussion://b">second</span> [dropped by Claude]');
  });

  it('appends to existing Orphaned comments section', () => {
    const content = [
      '# Spec',
      '',
      'Revised.',
      '',
      '## Orphaned comments',
      '',
      '- <span discussion-urls="discussion://existing">old orphan</span>',
    ].join('\n');
    const spans = [{ uuid: 'discussion://new', inner_text: 'new orphan' }];
    const result = ensureSpansPreserved(content, spans);
    // Existing orphan should still be there
    expect(result).toContain('discussion://existing');
    // New orphan appended
    expect(result).toContain('<span discussion-urls="discussion://new">new orphan</span> [dropped by Claude]');
  });

  it('only appends missing spans — preserves already-present ones', () => {
    const content = '# Spec\n\n<span discussion-urls="discussion://kept">kept</span> here.';
    const spans = [
      { uuid: 'discussion://kept', inner_text: 'kept' },
      { uuid: 'discussion://dropped', inner_text: 'dropped' },
    ];
    const result = ensureSpansPreserved(content, spans);
    expect(result).toContain('## Orphaned comments');
    expect(result).toContain('discussion://dropped');
    // The "kept" span should NOT be in the orphaned section
    const orphanedSection = result.slice(result.indexOf('## Orphaned comments'));
    expect(orphanedSection).not.toContain('discussion://kept');
  });
});

// ─── prettifyMarkdown ────────────────────────────────────────────────────

describe('prettifyMarkdown — heading spacing', () => {
  it('inserts blank line after # heading not followed by one', () => {
    const input = '# Title\nFirst paragraph.';
    const result = prettifyMarkdown(input);
    expect(result).toContain('# Title\n\nFirst paragraph.');
  });

  it('inserts blank line after ## heading', () => {
    const input = '## Section\nContent here.';
    const result = prettifyMarkdown(input);
    expect(result).toContain('## Section\n\nContent here.');
  });

  it('inserts blank line after ### heading', () => {
    const input = '### Sub\nContent.';
    const result = prettifyMarkdown(input);
    expect(result).toContain('### Sub\n\nContent.');
  });

  it('does not double-insert when heading already followed by blank line', () => {
    const input = '## Section\n\nContent here.';
    const result = prettifyMarkdown(input);
    expect(result).toBe('## Section\n\nContent here.');
  });

  it('handles heading at the end of file — no blank line inserted', () => {
    const input = '# Title\n\nParagraph.\n\n## End';
    const result = prettifyMarkdown(input);
    expect(result.endsWith('## End')).toBe(true);
  });
});

describe('prettifyMarkdown — blank line collapsing', () => {
  it('collapses three consecutive blank lines into one', () => {
    const input = 'Line 1\n\n\n\nLine 2';
    const result = prettifyMarkdown(input);
    expect(result).toBe('Line 1\n\nLine 2');
  });

  it('collapses many blank lines into one', () => {
    const input = 'A\n\n\n\n\n\nB';
    const result = prettifyMarkdown(input);
    expect(result).toBe('A\n\nB');
  });

  it('preserves single blank lines', () => {
    const input = 'Para 1\n\nPara 2';
    expect(prettifyMarkdown(input)).toBe('Para 1\n\nPara 2');
  });
});

describe('prettifyMarkdown — orphaned comments removal', () => {
  it('removes ## Orphaned comments section at end of file', () => {
    const input = '# Spec\n\nContent.\n\n## Orphaned comments\n\n- some orphan';
    const result = prettifyMarkdown(input);
    expect(result).not.toContain('## Orphaned comments');
    expect(result).not.toContain('some orphan');
    expect(result).toContain('Content.');
  });

  it('removes ## Orphaned comments section with content until end', () => {
    const input = [
      '# Spec',
      '',
      'Body.',
      '',
      '## Orphaned comments',
      '',
      '- orphan 1',
      '- orphan 2',
    ].join('\n');
    const result = prettifyMarkdown(input);
    expect(result).not.toContain('## Orphaned comments');
    expect(result).not.toContain('orphan 1');
    expect(result).toContain('Body.');
  });

  it('passes through content with no ## Orphaned comments section unchanged (aside from prettification)', () => {
    const input = '# Spec\n\nBody.';
    expect(prettifyMarkdown(input)).toBe('# Spec\n\nBody.');
  });

  it('preserves content after orphaned comments if followed by ## heading', () => {
    const input = [
      '# Spec',
      '',
      'Body.',
      '',
      '## Orphaned comments',
      '',
      '- orphan',
      '',
      '## Next Section',
      '',
      'Kept.',
    ].join('\n');
    const result = prettifyMarkdown(input);
    expect(result).not.toContain('orphan');
    // The ## Next Section and content following it should NOT be removed
    expect(result).toContain('## Next Section');
    expect(result).toContain('Kept.');
  });
});

// ─── stripAllHtml ────────────────────────────────────────────────────────

describe('stripAllHtml', () => {
  it('strips <table> and child tags, preserving cell text', () => {
    const input = '<table header-row="true"><tr><td>Cell A</td><td>Cell B</td></tr></table>';
    expect(stripAllHtml(input)).toBe('Cell ACell B');
  });

  it('strips <span discussion-urls> tags, preserving inner text', () => {
    const input = 'Before <span discussion-urls="discussion://abc">highlighted</span> after.';
    expect(stripAllHtml(input)).toBe('Before highlighted after.');
  });

  it('passes through content with no HTML unchanged', () => {
    const input = '# Heading\n\nSome paragraph text with no HTML.';
    expect(stripAllHtml(input)).toBe(input);
  });

  it('strips self-closing tags without leaving artifacts', () => {
    const input = 'Line 1<br/>Line 2';
    expect(stripAllHtml(input)).toBe('Line 1Line 2');
  });

  it('returns empty string for empty input', () => {
    expect(stripAllHtml('')).toBe('');
  });

  it('handles mixed HTML and markdown', () => {
    const input = '# Title\n\n<table><tr><td>data</td></tr></table>\n\nNormal paragraph.';
    const result = stripAllHtml(input);
    expect(result).not.toContain('<');
    expect(result).not.toContain('>');
    expect(result).toContain('data');
    expect(result).toContain('Normal paragraph.');
  });
});
