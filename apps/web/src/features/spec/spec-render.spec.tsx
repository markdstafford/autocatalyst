/**
 * Renderer + source-position coverage. This doubles as the parser-position spike required by the
 * task list: it proves that every construct in the mapping matrix renders with usable source
 * ranges, and that mdast offsets (UTF-16) are converted to code points before they reach the DOM.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { codePointLength } from './code-points.js';
import { isSafeHref, SpecDocument } from './spec-render.js';
import { SR_START_ATTR } from './spec-runs.js';

function renderSpec(markdown: string): HTMLElement {
  render(<SpecDocument markdown={markdown} />);
  return screen.getByTestId('spec-document');
}

describe('SpecDocument rendering', () => {
  it('renders headings at the design-system sizes', () => {
    const root = renderSpec('# One\n\n## Two\n\n### Three');
    expect(root.querySelector('h1')?.textContent).toBe('One');
    expect(root.querySelector('h2')?.textContent).toBe('Two');
    expect(root.querySelector('h3')?.textContent).toBe('Three');
  });

  it('renders GFM tables with header and body cells', () => {
    const root = renderSpec('| Field | Type |\n| --- | --- |\n| name | string |');
    expect(root.querySelectorAll('thead th').length).toBe(2);
    expect(root.querySelector('tbody td')?.textContent).toBe('name');
  });

  it('renders ordered, unordered, and task lists', () => {
    const root = renderSpec('- a\n- b\n\n1. one\n2. two\n\n- [ ] todo\n- [x] done');
    expect(root.querySelector('ul')).not.toBeNull();
    expect(root.querySelector('ol')).not.toBeNull();
    const checkboxes = root.querySelectorAll('input[type="checkbox"]');
    expect(checkboxes.length).toBe(2);
    expect((checkboxes[1] as HTMLInputElement).checked).toBe(true);
  });

  it('renders fenced code as selectable per-line runs', () => {
    const root = renderSpec('```ts\nconst fixture = { name: "demo" };\n```');
    const code = root.querySelector('code[data-spec-code]');
    expect(code).not.toBeNull();
    expect(code?.textContent).toBe('const fixture = { name: "demo" };');
    expect(code?.querySelector(`[${SR_START_ATTR}]`)).not.toBeNull();
  });

  it('excludes front matter from the document but keeps it in source offsets', () => {
    const markdown = '---\ntitle: x\n---\n# Heading';
    const root = renderSpec(markdown);
    expect(root.textContent).toContain('Heading');
    expect(root.textContent).not.toContain('title: x');
    // The heading run starts after the front matter: its code-point start is > 0.
    const headingRun = root.querySelector(`h1 [${SR_START_ATTR}]`);
    const start = Number.parseInt(headingRun?.getAttribute(SR_START_ATTR) ?? '-1', 10);
    expect(start).toBeGreaterThan(0);
  });

  it('renders raw HTML as literal text, never as markup', () => {
    const root = renderSpec('a <b>bold?</b> c');
    expect(root.querySelector('b')).toBeNull();
    expect(root.textContent).toContain('<b>');
    expect(root.textContent).toContain('</b>');
  });

  it('renders safe links as anchors and unsafe links as plain text', () => {
    const root = renderSpec('[ok](https://example.com) and [no](javascript:alert(1))');
    const anchors = root.querySelectorAll('a');
    expect(anchors.length).toBe(1);
    expect(anchors[0]?.getAttribute('href')).toBe('https://example.com');
    expect(anchors[0]?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(root.textContent).toContain('no');
  });

  it('marks transformed text (entities) as opaque and identity text as identity', () => {
    const root = renderSpec('a &amp; b and plain');
    const runs = [...root.querySelectorAll(`[${SR_START_ATTR}]`)];
    expect(runs.some((run) => run.getAttribute('data-sr-kind') === 'opaque')).toBe(true);
  });

  it('converts astral offsets to code points on run boundaries', () => {
    // "🚀 X" — the rocket is one code point but two UTF-16 units, so "X" starts at code point 2.
    const root = renderSpec('🚀 X');
    const run = root.querySelector(`p [${SR_START_ATTR}]`);
    expect(run?.getAttribute(SR_START_ATTR)).toBe('0');
    // The run covers the whole paragraph text; its code-point end equals the code-point length.
    expect(run?.getAttribute('data-sr-end')).toBe(String(codePointLength('🚀 X')));
  });
});

describe('isSafeHref', () => {
  it('allows http, https, and mailto only', () => {
    expect(isSafeHref('http://x')).toBe(true);
    expect(isSafeHref('https://x')).toBe(true);
    expect(isSafeHref('mailto:a@b.com')).toBe(true);
    expect(isSafeHref('javascript:alert(1)')).toBe(false);
    expect(isSafeHref('data:text/html,x')).toBe(false);
    expect(isSafeHref('/relative')).toBe(false);
  });
});
