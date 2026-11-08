/**
 * Shiki code-block behaviour: lazy highlighting that never changes selection mapping, plain text
 * for unknown languages, and re-highlighting on theme change.
 */
import { render, waitFor } from '@testing-library/react';
import { act } from 'react';
import { describe, expect, it } from 'vitest';

import { mapRangeToSourceAnchor, type SpecAnchorCandidate } from './selection-source-map.js';
import { SpecDocument } from './spec-render.js';
import { SR_END_ATTR, SR_START_ATTR } from './spec-runs.js';

function renderDoc(markdown: string): HTMLElement {
  const { container } = render(<SpecDocument markdown={markdown} />);
  return container.querySelector('[data-testid="spec-document"]') as HTMLElement;
}

function mapLine(root: HTMLElement, markdown: string, line: string): SpecAnchorCandidate | null {
  const code = root.querySelector('code[data-spec-code]') as HTMLElement;
  // Find the line run whose text is the line, then select its whole text content.
  const runs = [...code.querySelectorAll(`[${SR_START_ATTR}]`)] as HTMLElement[];
  const run = runs.find((r) => r.textContent === line);
  if (run === undefined) {
    return null;
  }
  const range = document.createRange();
  range.selectNodeContents(run);
  return mapRangeToSourceAnchor({ markdown, documentRoot: root, range });
}

function runSignature(root: HTMLElement): string {
  const code = root.querySelector('code[data-spec-code]') as HTMLElement;
  return [...code.querySelectorAll(`[${SR_START_ATTR}]`)]
    .map((r) => `${r.getAttribute(SR_START_ATTR)}:${r.getAttribute(SR_END_ATTR)}:${r.textContent}`)
    .join('|');
}

describe('CodeBlock Shiki integration', () => {
  it('keeps selection mapping identical before and after Shiki loads', async () => {
    const markdown = '```ts\nconst fixture = { name: "demo" };\n```';
    const root = renderDoc(markdown);
    const line = 'const fixture = { name: "demo" };';

    const before = mapLine(root, markdown, line);
    const signatureBefore = runSignature(root);
    expect(before?.quotedText).toBe(line);

    // Wait until Shiki has split the line into coloured token spans.
    await waitFor(() => {
      const code = root.querySelector('code[data-spec-code]') as HTMLElement;
      expect(code.querySelector('span[style]')).not.toBeNull();
    });

    const after = mapLine(root, markdown, line);
    expect(after).toEqual(before);
    // The run source ranges and text are unchanged; only inner colour spans were added.
    expect(runSignature(root)).toBe(signatureBefore);
  });

  it('renders an unknown language as plain selectable text', async () => {
    const markdown = '```unknownlang\nplain code line\n```';
    const root = renderDoc(markdown);
    const mapped = mapLine(root, markdown, 'plain code line');
    expect(mapped?.quotedText).toBe('plain code line');
    // Give any (non-)highlighting a tick; it must stay plain (no coloured spans).
    await act(async () => {
      await Promise.resolve();
    });
    const code = root.querySelector('code[data-spec-code]') as HTMLElement;
    expect(code.querySelector('span[style]')).toBeNull();
  });
});
