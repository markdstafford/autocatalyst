import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_PREFERENCES,
  PREFERENCES_STORAGE_KEY,
  readPreferences,
  resolveTheme,
  validatePreferences,
  writePreferences
} from './preferences.js';

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('validatePreferences', () => {
  it('returns defaults for a non-object', () => {
    expect(validatePreferences(null)).toEqual(DEFAULT_PREFERENCES);
    expect(validatePreferences(42)).toEqual(DEFAULT_PREFERENCES);
  });

  it('falls back field-by-field and keeps valid fields', () => {
    const result = validatePreferences({
      themeMode: 'dark',
      lightTheme: 'not-a-theme',
      darkTheme: 'dracula',
      primaryAccent: 'mauve',
      secondaryAccent: 'nope',
      bodyFont: 'inter',
      monoFont: 'bogus'
    });
    expect(result.themeMode).toBe('dark');
    expect(result.lightTheme).toBe(DEFAULT_PREFERENCES.lightTheme);
    expect(result.darkTheme).toBe('dracula');
    expect(result.primaryAccent).toBe('mauve');
    expect(result.secondaryAccent).toBe(DEFAULT_PREFERENCES.secondaryAccent);
    expect(result.bodyFont).toBe('inter');
    expect(result.monoFont).toBe(DEFAULT_PREFERENCES.monoFont);
  });

  it('defaults sidebarOpen to true when missing or non-boolean', () => {
    expect(validatePreferences({}).sidebarOpen).toBe(true);
    expect(validatePreferences({ sidebarOpen: 'yes' }).sidebarOpen).toBe(true);
    expect(validatePreferences({ sidebarOpen: 1 }).sidebarOpen).toBe(true);
    expect(validatePreferences(null).sidebarOpen).toBe(true);
  });

  it('keeps an explicit boolean sidebarOpen', () => {
    expect(validatePreferences({ sidebarOpen: false }).sidebarOpen).toBe(false);
    expect(validatePreferences({ sidebarOpen: true }).sidebarOpen).toBe(true);
  });
});

describe('readPreferences', () => {
  it('returns defaults when nothing is stored', () => {
    expect(readPreferences()).toEqual(DEFAULT_PREFERENCES);
  });

  it('returns defaults for invalid JSON without crashing', () => {
    window.localStorage.setItem(PREFERENCES_STORAGE_KEY, '{not valid json');
    expect(readPreferences()).toEqual(DEFAULT_PREFERENCES);
  });

  it('returns defaults when storage access throws (blocked storage)', () => {
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readPreferences()).toEqual(DEFAULT_PREFERENCES);
  });

  it('round-trips a valid stored value', () => {
    const prefs = { ...DEFAULT_PREFERENCES, themeMode: 'light' as const, primaryAccent: 'blue' as const };
    writePreferences(prefs);
    expect(readPreferences()).toEqual(prefs);
  });
});

describe('writePreferences', () => {
  it('does not throw when storage is blocked', () => {
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(() => writePreferences(DEFAULT_PREFERENCES)).not.toThrow();
  });
});

describe('resolveTheme', () => {
  it('uses the dark slot in system mode when the system prefers dark', () => {
    expect(resolveTheme(DEFAULT_PREFERENCES, true)).toEqual({ theme: 'catppuccin-mocha', mode: 'dark' });
  });

  it('uses the light slot in system mode when the system prefers light', () => {
    expect(resolveTheme(DEFAULT_PREFERENCES, false)).toEqual({ theme: 'catppuccin-latte', mode: 'light' });
  });

  it('honors an explicit light or dark mode regardless of the system', () => {
    expect(resolveTheme({ ...DEFAULT_PREFERENCES, themeMode: 'dark' }, false).mode).toBe('dark');
    expect(resolveTheme({ ...DEFAULT_PREFERENCES, themeMode: 'light' }, true).mode).toBe('light');
  });
});
