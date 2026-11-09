/**
 * Guards the comment marker fills stay **translucent**.
 *
 * Markers and the pending-selection highlight are overlay boxes drawn above the anchored text. If
 * their fills mix with `--color-background` (opaque) they paint over the words and only the underline
 * shows; mixing with `transparent` keeps the text readable while selecting and after a comment lands.
 * This test fails if a fill regresses to an opaque background mix.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(HERE, 'index.css'), 'utf-8');

function tokenValue(name: string): string {
  const match = new RegExp(`${name}:\\s*([^;]+);`).exec(CSS);
  if (match === null) {
    throw new Error(`token not found: ${name}`);
  }
  return (match[1] ?? '').trim();
}

describe('comment marker token fills', () => {
  for (const token of [
    '--color-comment-open-bg',
    '--color-comment-resolved-bg',
    '--color-comment-selected-bg',
    '--color-comment-flash-bg'
  ]) {
    it(`${token} is translucent (mixes with transparent, not the background)`, () => {
      const value = tokenValue(token);
      expect(value).toContain('transparent');
      expect(value).not.toContain('var(--color-background)');
    });
  }

  it('selected is stronger than open so the active marker is unmistakable', () => {
    const percent = (token: string): number => {
      const match = /(\d+)%/.exec(tokenValue(token));
      return match ? Number(match[1]) : 0;
    };
    expect(percent('--color-comment-selected-bg')).toBeGreaterThan(percent('--color-comment-open-bg'));
  });
});
