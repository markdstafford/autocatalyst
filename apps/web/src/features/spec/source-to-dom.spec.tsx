/**
 * Round-trip: a source range maps to a DOM Range that maps back to the same source anchor, so a
 * marker drawn for `[from, to)` highlights exactly the selected rendered text and nothing outside it.
 */
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { codePointLength } from './code-points.js';
import { mapRangeToSourceAnchor } from './selection-source-map.js';
import { sourceRangeToDomRange } from './source-to-dom.js';
import { SpecDocument } from './spec-render.js';

function renderDoc(markdown: string): HTMLElement {
  const { container } = render(<SpecDocument markdown={markdown} />);
  return container.querySelector('[data-testid="spec-document"]') as HTMLElement;
}

function cpIndexOf(text: string, needle: string): number {
  const utf16 = text.indexOf(needle);
  return utf16 < 0 ? -1 : codePointLength(text.slice(0, utf16));
}

const CASES: ReadonlyArray<{ md: string; needle: string }> = [
  { md: 'Hello precise world.', needle: 'precise' },
  { md: '## Title here\n\nbody', needle: 'Title here' },
  { md: 'an *em* word', needle: 'em' },
  { md: '🚀 A. Names must be unique within a tenant.', needle: 'A. Names must be unique within a tenant.' },
  { md: '```ts\nconst fixture = { name: "demo" };\n```', needle: 'const fixture = { name: "demo" };' },
  { md: '| Field | Type |\n| --- | --- |\n| name | string |', needle: 'string' }
];

describe('sourceRangeToDomRange round-trip', () => {
  for (const { md, needle } of CASES) {
    it(`round-trips ${JSON.stringify(needle)}`, () => {
      const root = renderDoc(md);
      const from = cpIndexOf(md, needle);
      const to = from + codePointLength(needle);
      const domRange = sourceRangeToDomRange(root, from, to);
      expect(domRange).not.toBeNull();
      const mapped = mapRangeToSourceAnchor({ markdown: md, documentRoot: root, range: domRange as Range });
      expect(mapped).not.toBeNull();
      expect(mapped?.from).toBe(from);
      expect(mapped?.to).toBe(to);
      expect(mapped?.quotedText).toBe(needle);
    });
  }

  it('returns null for an inverted range', () => {
    const root = renderDoc('hello');
    expect(sourceRangeToDomRange(root, 3, 1)).toBeNull();
  });
});
