/**
 * Gallery rendering and theming tests.
 *
 * Two guarantees:
 *  1. The gallery renders across the whole theme matrix — three light themes in light
 *     mode, five dark themes in dark mode, and system mode under a mocked light and dark
 *     OS color scheme — with no thrown error and no console warning, applying the expected
 *     root `data-theme`/`data-theme-mode`.
 *  2. The toolbar is preference-safe: changing every control leaves the stored
 *     `autocatalyst.preferences` value byte-identical, and unmounting restores the exact
 *     prior root attributes (including removing one that was absent).
 */
import { fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PREFERENCES_STORAGE_KEY, DARK_THEMES, LIGHT_THEMES } from '../theme/preferences.js';
import { ComponentsGallery } from './components-gallery.js';

function mockColorScheme(prefersDark: boolean): void {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: prefersDark,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false
  })) as unknown as typeof window.matchMedia;
}

afterEach(() => {
  // Remove the matchMedia stub and any root attributes left between cases.
  Reflect.deleteProperty(window, 'matchMedia');
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-theme-mode');
});

describe('gallery theme matrix', () => {
  it('renders the three light themes in light mode without warnings', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (const theme of LIGHT_THEMES) {
      const view = render(<ComponentsGallery initialMode="light" initialLightTheme={theme} />);
      expect(document.documentElement.getAttribute('data-theme')).toBe(theme);
      expect(document.documentElement.getAttribute('data-theme-mode')).toBe('light');
      view.unmount();
    }
    expect(spy).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    spy.mockRestore();
    warn.mockRestore();
  });

  it('renders the five dark themes in dark mode without warnings', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (const theme of DARK_THEMES) {
      const view = render(<ComponentsGallery initialMode="dark" initialDarkTheme={theme} />);
      expect(document.documentElement.getAttribute('data-theme')).toBe(theme);
      expect(document.documentElement.getAttribute('data-theme-mode')).toBe('dark');
      view.unmount();
    }
    expect(spy).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    spy.mockRestore();
    warn.mockRestore();
  });

  it('resolves system mode from the OS color scheme (light)', () => {
    mockColorScheme(false);
    const view = render(
      <ComponentsGallery initialMode="system" initialLightTheme="github-light" initialDarkTheme="dracula" />
    );
    expect(document.documentElement.getAttribute('data-theme')).toBe('github-light');
    expect(document.documentElement.getAttribute('data-theme-mode')).toBe('light');
    view.unmount();
  });

  it('resolves system mode from the OS color scheme (dark)', () => {
    mockColorScheme(true);
    const view = render(
      <ComponentsGallery initialMode="system" initialLightTheme="github-light" initialDarkTheme="dracula" />
    );
    expect(document.documentElement.getAttribute('data-theme')).toBe('dracula');
    expect(document.documentElement.getAttribute('data-theme-mode')).toBe('dark');
    view.unmount();
  });
});

describe('gallery is preference-safe', () => {
  it('never writes stored preferences when toolbar controls change', () => {
    const stored = JSON.stringify({ themeMode: 'light', lightTheme: 'github-light' });
    window.localStorage.setItem(PREFERENCES_STORAGE_KEY, stored);

    const { getByLabelText } = render(<ComponentsGallery initialMode="light" />);

    fireEvent.change(getByLabelText('Theme mode'), { target: { value: 'dark' } });
    fireEvent.change(getByLabelText('Dark theme'), { target: { value: 'github-dark' } });
    fireEvent.change(getByLabelText('Light theme'), { target: { value: 'solarized-light' } });
    fireEvent.change(getByLabelText('Key-cap platform'), { target: { value: 'other' } });

    expect(window.localStorage.getItem(PREFERENCES_STORAGE_KEY)).toBe(stored);
  });

  it('restores the previous root attributes on unmount', () => {
    const root = document.documentElement;
    root.setAttribute('data-theme', 'catppuccin-latte');
    // data-theme-mode is intentionally absent before mount.
    root.removeAttribute('data-theme-mode');

    const view = render(<ComponentsGallery initialMode="dark" initialDarkTheme="dracula" />);
    // While mounted the gallery drives the attributes.
    expect(root.getAttribute('data-theme')).toBe('dracula');
    expect(root.getAttribute('data-theme-mode')).toBe('dark');

    view.unmount();
    // The prior value is restored, and the previously-absent attribute is removed.
    expect(root.getAttribute('data-theme')).toBe('catppuccin-latte');
    expect(root.hasAttribute('data-theme-mode')).toBe(false);
  });
});
