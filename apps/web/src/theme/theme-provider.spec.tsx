/**
 * Theme provider rendering tests: it writes the html theme attributes, follows
 * the system color scheme in system mode, and updates attributes and stored
 * values when the operator changes mode, slot, and accent through the hook.
 */
import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PREFERENCES_STORAGE_KEY } from './preferences.js';
import { ThemeProvider, useTheme } from './theme-provider.js';

interface MediaControl {
  setMatches(matches: boolean): void;
}

function installMatchMedia(initialDark: boolean): MediaControl {
  let matches = initialDark;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const media = {
    get matches() {
      return matches;
    },
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.delete(listener);
    }
  };
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: () => media
  });
  return {
    setMatches(next: boolean) {
      matches = next;
      for (const listener of listeners) {
        listener({ matches: next } as MediaQueryListEvent);
      }
    }
  };
}

let captured: ReturnType<typeof useTheme> | undefined;

function Probe(): null {
  captured = useTheme();
  return null;
}

afterEach(() => {
  window.localStorage.clear();
  captured = undefined;
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, 'matchMedia');
});

function attrs() {
  const root = document.documentElement;
  return {
    theme: root.getAttribute('data-theme'),
    mode: root.getAttribute('data-theme-mode'),
    primary: root.getAttribute('data-primary-accent'),
    secondary: root.getAttribute('data-secondary-accent')
  };
}

describe('ThemeProvider', () => {
  it('sets all four theme attributes on the html element', () => {
    installMatchMedia(false);
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>
    );
    expect(attrs()).toEqual({
      theme: 'catppuccin-latte',
      mode: 'light',
      primary: 'sapphire',
      secondary: 'teal'
    });
  });

  it('follows prefers-color-scheme in system mode, including later changes', () => {
    const control = installMatchMedia(true);
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>
    );
    expect(attrs().mode).toBe('dark');
    expect(attrs().theme).toBe('catppuccin-mocha');

    act(() => {
      control.setMatches(false);
    });
    expect(attrs().mode).toBe('light');
    expect(attrs().theme).toBe('catppuccin-latte');
  });

  it('updates attributes and stored values through the hook', () => {
    installMatchMedia(false);
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>
    );

    act(() => {
      captured?.setThemeMode('dark');
      captured?.setDarkTheme('github-dark');
      captured?.setPrimaryAccent('mauve');
      captured?.setSecondaryAccent('green');
    });

    expect(attrs()).toEqual({
      theme: 'github-dark',
      mode: 'dark',
      primary: 'mauve',
      secondary: 'green'
    });

    const stored = JSON.parse(window.localStorage.getItem(PREFERENCES_STORAGE_KEY) ?? '{}');
    expect(stored.themeMode).toBe('dark');
    expect(stored.darkTheme).toBe('github-dark');
    expect(stored.primaryAccent).toBe('mauve');
    expect(stored.secondaryAccent).toBe('green');
  });
});
