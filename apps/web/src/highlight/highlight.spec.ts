/**
 * Shiki loader tests against the real fine-grained core: the highlighter is
 * created once and reused across calls, and the light/dark code themes produce
 * different markup for the same JSON. (The manifest/chunk assertions live in the
 * build output test, which inspects the emitted bundle.)
 */
import { describe, expect, it } from 'vitest';

import { getJsonHighlighter, highlightJson } from './highlight.js';

const SAMPLE = JSON.stringify({ status: 'ok', database: { status: 'reachable' } }, null, 2);

describe('json highlighter', () => {
  it('creates the highlighter once and reuses it', async () => {
    const first = await getJsonHighlighter();
    const second = await getJsonHighlighter();
    // Same instance => the dynamic import and highlighter creation ran once.
    expect(second).toBe(first);
  });

  it('produces different markup for light and dark code themes', async () => {
    const light = await highlightJson(SAMPLE, 'light');
    const dark = await highlightJson(SAMPLE, 'dark');

    expect(light).toContain('<pre');
    expect(dark).toContain('<pre');
    // The highlighted tokens include the status value for both themes...
    expect(light).toContain('status');
    expect(dark).toContain('status');
    // ...but the theme colors differ, so the markup is not identical.
    expect(light).not.toBe(dark);
  });
});
