/**
 * Operator theme preferences: schema, defaults, field-level validation, and
 * guarded localStorage access.
 *
 * Storage is untrusted: every read and write is wrapped in try/catch, invalid
 * JSON and blocked storage fall back to defaults without throwing, and unknown
 * theme or accent ids fall back field-by-field while preserving the valid fields.
 */

export const PREFERENCES_STORAGE_KEY = 'autocatalyst.preferences';

export const LIGHT_THEMES = ['catppuccin-latte', 'github-light', 'solarized-light'] as const;
export const DARK_THEMES = [
  'catppuccin-frappe',
  'catppuccin-macchiato',
  'catppuccin-mocha',
  'github-dark',
  'dracula'
] as const;

export const ACCENT_IDS = [
  'rosewater', 'flamingo', 'pink', 'mauve', 'red', 'maroon', 'peach',
  'yellow', 'green', 'teal', 'sky', 'sapphire', 'blue', 'lavender'
] as const;

export const THEME_MODES = ['system', 'light', 'dark'] as const;

export const BODY_FONT_IDS = ['inter', 'system'] as const;
export const MONO_FONT_IDS = ['fira-code', 'system-mono'] as const;

export type LightTheme = (typeof LIGHT_THEMES)[number];
export type DarkTheme = (typeof DARK_THEMES)[number];
export type ThemeId = LightTheme | DarkTheme;
export type AccentId = (typeof ACCENT_IDS)[number];
export type ThemeMode = (typeof THEME_MODES)[number];
export type BodyFontId = (typeof BODY_FONT_IDS)[number];
export type MonoFontId = (typeof MONO_FONT_IDS)[number];

export interface Preferences {
  readonly themeMode: ThemeMode;
  readonly lightTheme: LightTheme;
  readonly darkTheme: DarkTheme;
  readonly primaryAccent: AccentId;
  readonly secondaryAccent: AccentId;
  readonly bodyFont: BodyFontId;
  readonly monoFont: MonoFontId;
  /**
   * Whether the primary sidebar is open. Shell state (#132) rides on the same
   * preferences object so a single guarded write persists both theme and layout.
   */
  readonly sidebarOpen: boolean;
  /** Whether the side detail pane is shown (#134). */
  readonly detailPaneVisible: boolean;
  /** Side detail pane width in px (#134), clamped to the design-system range on read. */
  readonly sidePaneWidthPx: number;
}

// Side detail pane dimensions (design-system `--width-pane`).
export const PANE_WIDTH_DEFAULT = 440;
export const PANE_WIDTH_MIN = 320;
export const PANE_WIDTH_MAX = 720;
/** The pane takes at most this share of the main area so the list keeps room. */
export const PANE_MAX_MAIN_SHARE = 0.6;

/**
 * Clamp a pane width to the design-system minimum/maximum, and — when a main-area
 * width is known — to the maximum share of that area. Non-finite input falls back to
 * the default.
 */
export function clampPaneWidth(width: number, mainAreaWidth?: number): number {
  const base = Number.isFinite(width) ? width : PANE_WIDTH_DEFAULT;
  let max = PANE_WIDTH_MAX;
  if (mainAreaWidth !== undefined && Number.isFinite(mainAreaWidth) && mainAreaWidth > 0) {
    max = Math.min(max, Math.floor(mainAreaWidth * PANE_MAX_MAIN_SHARE));
  }
  const lowerBounded = Math.max(PANE_WIDTH_MIN, base);
  return Math.min(max, lowerBounded);
}

export const DEFAULT_PREFERENCES: Preferences = {
  themeMode: 'system',
  lightTheme: 'catppuccin-latte',
  darkTheme: 'catppuccin-mocha',
  primaryAccent: 'sapphire',
  secondaryAccent: 'teal',
  bodyFont: 'inter',
  monoFont: 'fira-code',
  sidebarOpen: true,
  detailPaneVisible: true,
  sidePaneWidthPx: PANE_WIDTH_DEFAULT
};

/** Font stacks keyed by the stored font id. */
export const BODY_FONT_STACKS: Readonly<Record<BodyFontId, string>> = {
  inter: "'Inter Variable', ui-sans-serif, system-ui, sans-serif",
  system: 'ui-sans-serif, system-ui, sans-serif'
};

export const MONO_FONT_STACKS: Readonly<Record<MonoFontId, string>> = {
  'fira-code': "'Fira Code', ui-monospace, monospace",
  'system-mono': 'ui-monospace, monospace'
};

function oneOf<T extends string>(values: readonly T[], candidate: unknown): T | undefined {
  return typeof candidate === 'string' && (values as readonly string[]).includes(candidate)
    ? (candidate as T)
    : undefined;
}

/** Validate a boolean, falling back to `fallback` for missing or non-boolean values. */
function boolOr(candidate: unknown, fallback: boolean): boolean {
  return typeof candidate === 'boolean' ? candidate : fallback;
}

/** Validate a finite number, falling back to `fallback` otherwise. */
function numberOr(candidate: unknown, fallback: number): number {
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : fallback;
}

/**
 * Validate an arbitrary parsed value into a complete `Preferences`, falling back
 * field-by-field to the defaults. Always returns a valid object.
 */
export function validatePreferences(input: unknown): Preferences {
  const source = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  return {
    themeMode: oneOf(THEME_MODES, source['themeMode']) ?? DEFAULT_PREFERENCES.themeMode,
    lightTheme: oneOf(LIGHT_THEMES, source['lightTheme']) ?? DEFAULT_PREFERENCES.lightTheme,
    darkTheme: oneOf(DARK_THEMES, source['darkTheme']) ?? DEFAULT_PREFERENCES.darkTheme,
    primaryAccent: oneOf(ACCENT_IDS, source['primaryAccent']) ?? DEFAULT_PREFERENCES.primaryAccent,
    secondaryAccent: oneOf(ACCENT_IDS, source['secondaryAccent']) ?? DEFAULT_PREFERENCES.secondaryAccent,
    bodyFont: oneOf(BODY_FONT_IDS, source['bodyFont']) ?? DEFAULT_PREFERENCES.bodyFont,
    monoFont: oneOf(MONO_FONT_IDS, source['monoFont']) ?? DEFAULT_PREFERENCES.monoFont,
    sidebarOpen: boolOr(source['sidebarOpen'], DEFAULT_PREFERENCES.sidebarOpen),
    detailPaneVisible: boolOr(source['detailPaneVisible'], DEFAULT_PREFERENCES.detailPaneVisible),
    sidePaneWidthPx: clampPaneWidth(numberOr(source['sidePaneWidthPx'], DEFAULT_PREFERENCES.sidePaneWidthPx))
  };
}

/** Read and validate stored preferences; returns defaults on any failure. */
export function readPreferences(): Preferences {
  try {
    const raw = window.localStorage.getItem(PREFERENCES_STORAGE_KEY);
    if (raw === null) {
      return DEFAULT_PREFERENCES;
    }
    return validatePreferences(JSON.parse(raw));
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

/** Persist preferences; swallows storage failures (private mode, quota, blocked). */
export function writePreferences(preferences: Preferences): void {
  try {
    window.localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Storage unavailable; preferences remain in memory for this session only.
  }
}

/** The concrete theme and brightness selected after applying mode + system scheme. */
export interface ResolvedTheme {
  readonly theme: ThemeId;
  readonly mode: 'light' | 'dark';
}

/**
 * Resolve the active theme from preferences and the system color scheme. In
 * `system` mode the brightness follows `prefersDark`; otherwise the explicit
 * light/dark slot is used.
 */
export function resolveTheme(preferences: Preferences, prefersDark: boolean): ResolvedTheme {
  const useDark = preferences.themeMode === 'dark' || (preferences.themeMode === 'system' && prefersDark);
  return useDark
    ? { theme: preferences.darkTheme, mode: 'dark' }
    : { theme: preferences.lightTheme, mode: 'light' };
}
