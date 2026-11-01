/**
 * Executes the exact inline first-paint script source against stored preferences
 * and asserts it sets `data-theme` on its own, before any app code runs.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FIRST_PAINT_SCRIPT } from './first-paint.js';

function runFirstPaint(): void {
  new Function(FIRST_PAINT_SCRIPT)();
}

afterEach(() => {
  window.localStorage.clear();
  const root = document.documentElement;
  for (const attr of ['data-theme', 'data-theme-mode', 'data-primary-accent', 'data-secondary-accent']) {
    root.removeAttribute(attr);
  }
  vi.restoreAllMocks();
});

describe('first-paint script', () => {
  it('sets a dark data-theme from a stored dark preference', () => {
    window.localStorage.setItem(
      'autocatalyst.preferences',
      JSON.stringify({ themeMode: 'dark', darkTheme: 'dracula', primaryAccent: 'mauve', secondaryAccent: 'green' })
    );

    runFirstPaint();

    const root = document.documentElement;
    expect(root.getAttribute('data-theme')).toBe('dracula');
    expect(root.getAttribute('data-theme-mode')).toBe('dark');
    expect(root.getAttribute('data-primary-accent')).toBe('mauve');
    expect(root.getAttribute('data-secondary-accent')).toBe('green');
  });

  it('falls back to defaults when nothing is stored', () => {
    runFirstPaint();
    const root = document.documentElement;
    // jsdom has no matchMedia, so system resolves to the light slot.
    expect(root.getAttribute('data-theme')).toBe('catppuccin-latte');
    expect(root.getAttribute('data-theme-mode')).toBe('light');
    expect(root.getAttribute('data-primary-accent')).toBe('sapphire');
    expect(root.getAttribute('data-secondary-accent')).toBe('teal');
  });

  it('does not throw on invalid JSON', () => {
    window.localStorage.setItem('autocatalyst.preferences', '{broken');
    expect(() => runFirstPaint()).not.toThrow();
    expect(document.documentElement.getAttribute('data-theme')).toBe('catppuccin-latte');
  });

  it('does not throw when storage access is blocked', () => {
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => runFirstPaint()).not.toThrow();
    expect(document.documentElement.getAttribute('data-theme')).toBe('catppuccin-latte');
  });

  it('falls back field-by-field for unknown ids', () => {
    window.localStorage.setItem(
      'autocatalyst.preferences',
      JSON.stringify({ themeMode: 'dark', darkTheme: 'not-real', primaryAccent: 'bogus' })
    );
    runFirstPaint();
    const root = document.documentElement;
    expect(root.getAttribute('data-theme')).toBe('catppuccin-mocha');
    expect(root.getAttribute('data-primary-accent')).toBe('sapphire');
  });
});
