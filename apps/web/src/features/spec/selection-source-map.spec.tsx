/**
 * Selection-mapping coverage over the issue #137 mapping matrix.
 *
 * Every test renders through the production {@link SpecDocument} and drives real DOM Range APIs,
 * then asserts the core invariant: for a non-null result, `quotedText === sliceByCodePoints(markdown,
 * from, to)` and `from < to`, and the quoted text contains the selected rendered characters. The
 * headline cases (astral offsets, soft line breaks, the revised fixture) also assert exact offsets.
 */
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { codePointLength, codePointOffsetToUtf16Index, sliceByCodePoints } from './code-points.js';
import { mapRangeToSourceAnchor, type SpecAnchorCandidate } from './selection-source-map.js';
import { SpecDocument } from './spec-render.js';

// Fixture literals kept in sync with apps/control-plane/src/fake/constants.ts. They are duplicated
// rather than imported to avoid a cross-package (web ← control-plane) source import in a web spec.
const SPEC_EMOJI = '🚀';
const SPEC_PASSAGE_A = 'A. Names must be unique within a tenant.';

function renderDoc(markdown: string): HTMLElement {
  const { container } = render(<SpecDocument markdown={markdown} />);
  // Scope to this render's container so tests that render several documents do not clash.
  return container.querySelector('[data-testid="spec-document"]') as HTMLElement;
}

interface TextPos {
  node: Text;
  start: number;
}

/** Build a Range over the first (or Nth) occurrence of `needle` in the rendered DOM text. */
function rangeOver(root: HTMLElement, needle: string, occurrence = 0): Range {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: TextPos[] = [];
  let text = '';
  let current = walker.nextNode();
  while (current !== null) {
    const node = current as Text;
    nodes.push({ node, start: text.length });
    text += node.data;
    current = walker.nextNode();
  }
  let idx = text.indexOf(needle);
  for (let i = 0; i < occurrence && idx >= 0; i += 1) {
    idx = text.indexOf(needle, idx + 1);
  }
  if (idx < 0) {
    throw new Error(`needle not found in rendered text: ${JSON.stringify(needle)}`);
  }
  return rangeForGlobal(nodes, idx, idx + needle.length);
}

/** Build a Range from global text offsets, choosing boundary nodes the way a browser would. */
function rangeForGlobal(nodes: TextPos[], startGlobal: number, endGlobal: number): Range {
  const start = locateStart(nodes, startGlobal);
  const end = locateEnd(nodes, endGlobal);
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  return range;
}

// Start boundary: the node that *contains* the character at the offset (strict upper bound), so a
// selection beginning at a node boundary starts in the node whose text begins there.
function locateStart(nodes: TextPos[], globalOffset: number): { node: Text; offset: number } {
  for (const entry of nodes) {
    if (globalOffset < entry.start + entry.node.data.length) {
      return { node: entry.node, offset: Math.max(0, globalOffset - entry.start) };
    }
  }
  const last = nodes[nodes.length - 1] as TextPos;
  return { node: last.node, offset: last.node.data.length };
}

// End boundary: the node that *ends* at or after the offset (inclusive), so a selection ending at a
// node boundary ends in the node whose text ends there.
function locateEnd(nodes: TextPos[], globalOffset: number): { node: Text; offset: number } {
  for (const entry of nodes) {
    if (globalOffset <= entry.start + entry.node.data.length) {
      return { node: entry.node, offset: globalOffset - entry.start };
    }
  }
  const last = nodes[nodes.length - 1] as TextPos;
  return { node: last.node, offset: last.node.data.length };
}

/** Collect the rendered text nodes and their global start offsets. */
function textNodes(root: HTMLElement): { nodes: TextPos[]; text: string } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: TextPos[] = [];
  let text = '';
  let current = walker.nextNode();
  while (current !== null) {
    const node = current as Text;
    nodes.push({ node, start: text.length });
    text += node.data;
    current = walker.nextNode();
  }
  return { nodes, text };
}

/** Build a Range from the start of `startNeedle` to the end of `endNeedle` (for cross-block spans). */
function rangeBetween(root: HTMLElement, startNeedle: string, endNeedle: string): Range {
  const { nodes, text } = textNodes(root);
  const startIdx = text.indexOf(startNeedle);
  const endIdx = text.indexOf(endNeedle);
  if (startIdx < 0 || endIdx < 0) {
    throw new Error('cross-block needles not found');
  }
  return rangeForGlobal(nodes, startIdx, endIdx + endNeedle.length);
}

function mapNeedle(markdown: string, needle: string, occurrence = 0): SpecAnchorCandidate | null {
  const root = renderDoc(markdown);
  const range = rangeOver(root, needle, occurrence);
  return mapRangeToSourceAnchor({ markdown, documentRoot: root, range });
}

/** Assert the universal invariant and that the quote contains the selected rendered text. */
function expectInvariant(markdown: string, result: SpecAnchorCandidate | null, mustContain?: string): SpecAnchorCandidate {
  expect(result).not.toBeNull();
  const candidate = result as SpecAnchorCandidate;
  expect(candidate.from).toBeLessThan(candidate.to);
  expect(candidate.quotedText).toBe(sliceByCodePoints(markdown, candidate.from, candidate.to));
  if (mustContain !== undefined) {
    expect(candidate.quotedText).toContain(mustContain);
  }
  return candidate;
}

/** Code-point index of the first occurrence of `needle` in `text`. */
function cpIndexOf(text: string, needle: string): number {
  const utf16 = text.indexOf(needle);
  return utf16 < 0 ? -1 : codePointLength(text.slice(0, utf16));
}

afterEach(() => {
  // Component cleanup is wired in test-setup; selections do not persist across jsdom documents.
});

describe('mapRangeToSourceAnchor — mapping matrix', () => {
  it('maps a plain paragraph selection to its source slice', () => {
    const md = 'Hello precise world.';
    const result = mapNeedle(md, 'precise');
    const c = expectInvariant(md, result, 'precise');
    expect(c.quotedText).toBe('precise');
    expect(c.from).toBe(cpIndexOf(md, 'precise'));
  });

  it('maps a heading selection without the ## markers', () => {
    const md = '## Title here\n\nbody';
    const c = expectInvariant(md, mapNeedle(md, 'Title here'), 'Title here');
    expect(c.quotedText).toBe('Title here');
  });

  it('maps emphasis, strong, and strikethrough inner text', () => {
    expect(expectInvariant('an *em* word', mapNeedle('an *em* word', 'em')).quotedText).toBe('em');
    expect(expectInvariant('a **bold** b', mapNeedle('a **bold** b', 'bold')).quotedText).toBe('bold');
    expect(expectInvariant('a ~~gone~~ b', mapNeedle('a ~~gone~~ b', 'gone')).quotedText).toBe('gone');
  });

  it('includes hidden emphasis markers when the selection spans across them', () => {
    const md = 'an *em* word';
    const c = expectInvariant(md, mapNeedle(md, 'an em word'));
    expect(c.quotedText).toBe('an *em* word');
  });

  it('snaps an inline-code selection outward to include the backticks', () => {
    const md = 'use `code` here';
    const c = expectInvariant(md, mapNeedle(md, 'code'), 'code');
    expect(c.quotedText).toBe('`code`');
    expect(c.from).toBe(cpIndexOf(md, '`code`'));
  });

  it('maps a link label to its source text', () => {
    const md = '[text](https://x.com)';
    const c = expectInvariant(md, mapNeedle(md, 'text'));
    expect(c.quotedText).toBe('text');
  });

  it('maps list item and task-list item text', () => {
    const md = '- one\n- two\n\n- [ ] todo\n- [x] done';
    expect(expectInvariant(md, mapNeedle(md, 'two')).quotedText).toBe('two');
    expect(expectInvariant(md, mapNeedle(md, 'todo')).quotedText).toBe('todo');
  });

  it('maps a table cell selection', () => {
    const md = '| Field | Type |\n| --- | --- |\n| name | string |';
    expect(expectInvariant(md, mapNeedle(md, 'string')).quotedText).toBe('string');
  });

  it('maps a fenced code line to its source', () => {
    const md = '```ts\nconst fixture = { name: "demo" };\n```';
    const c = expectInvariant(md, mapNeedle(md, 'const fixture = { name: "demo" };'), 'const fixture');
    expect(c.quotedText).toBe('const fixture = { name: "demo" };');
  });

  it('maps a fenced code line inside a block quote (invariant only)', () => {
    const md = '> intro\n>\n> ```ts\n> const x = 1;\n> ```';
    expectInvariant(md, mapNeedle(md, 'const x = 1;'), 'const x = 1;');
  });

  it('maps a fenced code line inside a list (invariant only)', () => {
    const md = '- item\n\n  ```ts\n  const y = 2;\n  ```';
    expectInvariant(md, mapNeedle(md, 'const y = 2;'), 'const y = 2;');
  });

  it('maps a selection spanning multiple blocks to the minimal source range', () => {
    const md = '# Heading\n\nParagraph body.';
    const root = renderDoc(md);
    const range = rangeBetween(root, 'Heading', 'Paragraph');
    const c = expectInvariant(md, mapRangeToSourceAnchor({ markdown: md, documentRoot: root, range }));
    // Minimal source range from the first selected char to the last, including the block syntax between.
    expect(c.quotedText).toBe('Heading\n\nParagraph');
  });

  it('maps across a soft line break and includes the source newline (LF)', () => {
    const md = 'line1\nline2';
    const c = expectInvariant(md, mapNeedle(md, 'line1\nline2'));
    expect(c.quotedText).toBe('line1\nline2');
    expect(c.from).toBe(0);
    expect(c.to).toBe(codePointLength(md));
  });

  it('maps a selection starting just after a soft line break', () => {
    const md = 'line1\nline2';
    const c = expectInvariant(md, mapNeedle(md, 'line2'));
    expect(c.quotedText).toBe('line2');
    expect(c.from).toBe(cpIndexOf(md, 'line2'));
  });

  it('counts a CRLF soft break as two code points', () => {
    const md = 'line1\r\nline2';
    const c = expectInvariant(md, mapNeedle(md, 'line1\r\nline2'));
    expect(c.quotedText).toBe('line1\r\nline2');
    expect(c.to - c.from).toBe(codePointLength(md));
  });

  it('includes a tab character in the source slice', () => {
    const md = 'a\tb';
    const c = expectInvariant(md, mapNeedle(md, 'a\tb'));
    expect(c.quotedText).toBe('a\tb');
  });

  it('snaps outward over an HTML entity (opaque run)', () => {
    const md = 'a &amp; b';
    const c = expectInvariant(md, mapNeedle(md, '& b'));
    expect(c.quotedText).toBe('a &amp; b');
  });

  it('snaps outward over a backslash escape (opaque run)', () => {
    const md = 'a \\* b';
    const c = expectInvariant(md, mapNeedle(md, '*'));
    expect(c.quotedText).toBe('a \\* b');
  });

  it('includes a hard break source in a cross-break selection', () => {
    const md = 'a  \nb';
    const c = expectInvariant(md, mapNeedle(md, 'ab'));
    expect(c.quotedText).toBe('a  \nb');
  });

  it('renders raw HTML as literal text and maps its source', () => {
    const md = 'a <b>c</b> d';
    expect(expectInvariant(md, mapNeedle(md, 'c')).quotedText).toBe('c');
    expect(expectInvariant(md, mapNeedle(md, 'a <b>c</b> d')).quotedText).toBe('a <b>c</b> d');
  });

  it('maps a passage after an astral emoji with a code-point offset one lower than UTF-16', () => {
    const md = `${SPEC_EMOJI} ${SPEC_PASSAGE_A}`;
    const c = expectInvariant(md, mapNeedle(md, SPEC_PASSAGE_A), SPEC_PASSAGE_A);
    expect(c.quotedText).toBe(SPEC_PASSAGE_A);
    // The rocket is 1 code point but 2 UTF-16 units, so `from` is exactly one below the UTF-16 index.
    const utf16Index = md.indexOf(SPEC_PASSAGE_A);
    expect(c.from).toBe(utf16Index - 1);
    expect(codePointOffsetToUtf16Index(md, c.from)).toBe(utf16Index);
  });

  it('excludes front matter from a full-document selection', () => {
    const md = '---\ntitle: secret\n---\n# Heading\n\nBody text.';
    const root = renderDoc(md);
    const range = document.createRange();
    range.selectNodeContents(root);
    const c = expectInvariant(md, mapRangeToSourceAnchor({ markdown: md, documentRoot: root, range }));
    expect(c.quotedText).not.toContain('title: secret');
    expect(c.from).toBe(cpIndexOf(md, '# Heading') + 2); // after "# "
  });
});

describe('mapRangeToSourceAnchor — invalid selections', () => {
  it('returns null for a collapsed selection', () => {
    const root = renderDoc('hello world');
    const range = document.createRange();
    const textNode = root.querySelector('span')?.firstChild as Text;
    range.setStart(textNode, 2);
    range.collapse(true);
    expect(mapRangeToSourceAnchor({ markdown: 'hello world', documentRoot: root, range })).toBeNull();
  });

  it('returns null for a whitespace-only selection', () => {
    const md = 'a      b';
    // Select the run of spaces only.
    expect(mapNeedle(md, '    ')).toBeNull();
  });

  it('returns null when a boundary is outside the document', () => {
    const md = 'hello world';
    const root = renderDoc(md);
    const outside = document.createElement('div');
    outside.textContent = 'elsewhere';
    document.body.appendChild(outside);
    const range = document.createRange();
    range.setStart(outside.firstChild as Text, 0);
    range.setEnd(outside.firstChild as Text, 4);
    expect(mapRangeToSourceAnchor({ markdown: md, documentRoot: root, range })).toBeNull();
    outside.remove();
  });
});

describe('mapRangeToSourceAnchor — soft break before passage A (revised fixture shape)', () => {
  // The revision inserts a list item immediately before the emoji + passage A with no blank line,
  // so Markdown renders passage A after a soft line break inside the inserted list item.
  const first = `${SPEC_EMOJI} ${SPEC_PASSAGE_A}`;
  const revised = `- A name is trimmed of leading and trailing spaces.\n${SPEC_EMOJI} ${SPEC_PASSAGE_A}`;

  it('still maps passage A exactly when it follows a soft break', () => {
    const firstMapped = expectInvariant(first, mapNeedle(first, SPEC_PASSAGE_A), SPEC_PASSAGE_A);
    const revisedMapped = expectInvariant(revised, mapNeedle(revised, SPEC_PASSAGE_A), SPEC_PASSAGE_A);
    expect(firstMapped.quotedText).toBe(SPEC_PASSAGE_A);
    expect(revisedMapped.quotedText).toBe(SPEC_PASSAGE_A);
    // Passage A moved forward by the inserted source text in the revision.
    expect(revisedMapped.from).toBeGreaterThan(firstMapped.from);
    expect(revisedMapped.from).toBe(cpIndexOf(revised, SPEC_PASSAGE_A));
  });
});
