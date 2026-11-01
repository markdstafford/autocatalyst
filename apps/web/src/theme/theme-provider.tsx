/**
 * Theme provider and hook.
 *
 * Applies the design-system theme to `document.documentElement` and exposes
 * controlled preference updates. It sets `data-theme`, `data-theme-mode`,
 * `data-primary-accent`, and `data-secondary-accent`; follows
 * `prefers-color-scheme` while in `system` mode; and persists every change
 * through the guarded storage helpers.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from 'react';

import {
  BODY_FONT_STACKS,
  DEFAULT_PREFERENCES,
  MONO_FONT_STACKS,
  readPreferences,
  resolveTheme,
  writePreferences,
  type AccentId,
  type BodyFontId,
  type DarkTheme,
  type LightTheme,
  type MonoFontId,
  type Preferences,
  type ResolvedTheme,
  type ThemeMode
} from './preferences.js';

const DARK_QUERY = '(prefers-color-scheme: dark)';

function systemPrefersDark(): boolean {
  try {
    return typeof window.matchMedia === 'function' && window.matchMedia(DARK_QUERY).matches;
  } catch {
    return false;
  }
}

export interface ThemeContextValue {
  readonly preferences: Preferences;
  readonly resolvedTheme: ResolvedTheme;
  setThemeMode(mode: ThemeMode): void;
  setLightTheme(theme: LightTheme): void;
  setDarkTheme(theme: DarkTheme): void;
  setPrimaryAccent(accent: AccentId): void;
  setSecondaryAccent(accent: AccentId): void;
  setBodyFont(font: BodyFontId): void;
  setMonoFont(font: MonoFontId): void;
  updatePreferences(patch: Partial<Preferences>): void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

function applyToDocument(preferences: Preferences, resolved: ResolvedTheme): void {
  const root = document.documentElement;
  root.setAttribute('data-theme', resolved.theme);
  root.setAttribute('data-theme-mode', resolved.mode);
  root.setAttribute('data-primary-accent', preferences.primaryAccent);
  root.setAttribute('data-secondary-accent', preferences.secondaryAccent);
  root.style.setProperty('--font-sans', BODY_FONT_STACKS[preferences.bodyFont]);
  root.style.setProperty('--font-mono', MONO_FONT_STACKS[preferences.monoFont]);
}

export interface ThemeProviderProps {
  readonly children: ReactNode;
  /** Test seam: initial preferences (defaults to the stored value). */
  readonly initialPreferences?: Preferences;
}

export function ThemeProvider({ children, initialPreferences }: ThemeProviderProps): ReactNode {
  const [preferences, setPreferences] = useState<Preferences>(
    () => initialPreferences ?? readPreferences()
  );
  const [prefersDark, setPrefersDark] = useState<boolean>(() => systemPrefersDark());

  const resolvedTheme = useMemo(
    () => resolveTheme(preferences, prefersDark),
    [preferences, prefersDark]
  );

  // Apply attributes and persist whenever the resolved theme or preferences change.
  useEffect(() => {
    applyToDocument(preferences, resolvedTheme);
  }, [preferences, resolvedTheme]);

  useEffect(() => {
    writePreferences(preferences);
  }, [preferences]);

  // Follow the system color scheme while in system mode.
  useEffect(() => {
    if (preferences.themeMode !== 'system') {
      return;
    }
    let media: MediaQueryList;
    try {
      if (typeof window.matchMedia !== 'function') {
        return;
      }
      media = window.matchMedia(DARK_QUERY);
    } catch {
      return;
    }
    const listener = (event: MediaQueryListEvent): void => {
      setPrefersDark(event.matches);
    };
    setPrefersDark(media.matches);
    media.addEventListener('change', listener);
    return () => {
      media.removeEventListener('change', listener);
    };
  }, [preferences.themeMode]);

  const updatePreferences = useCallback((patch: Partial<Preferences>): void => {
    setPreferences((current) => ({ ...current, ...patch }));
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      preferences,
      resolvedTheme,
      setThemeMode: (mode) => updatePreferences({ themeMode: mode }),
      setLightTheme: (theme) => updatePreferences({ lightTheme: theme }),
      setDarkTheme: (theme) => updatePreferences({ darkTheme: theme }),
      setPrimaryAccent: (accent) => updatePreferences({ primaryAccent: accent }),
      setSecondaryAccent: (accent) => updatePreferences({ secondaryAccent: accent }),
      setBodyFont: (font) => updatePreferences({ bodyFont: font }),
      setMonoFont: (font) => updatePreferences({ monoFont: font }),
      updatePreferences
    }),
    [preferences, resolvedTheme, updatePreferences]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (value === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider.');
  }
  return value;
}

export { DEFAULT_PREFERENCES };
