/**
 * Shell keyboard definitions — the single source of truth for shell shortcuts
 * until #134 introduces the action registry.
 *
 * The table uses the registry shape #134 will own: `id`, `label`, `keys`, and
 * `appliesWhen`. Hooks, tooltip key text, and the README read from here;
 * components never hard-code `[` or `]`. #134 can replace this table with registry
 * entries without touching components.
 *
 * Key matching uses `KeyboardEvent.key` for printable bracket shortcuts so the
 * visible character matches the tooltip. AltGr is treated as a text-entry modifier:
 * when `getModifierState('AltGraph')` is true, single-key shortcuts do not fire, so
 * layouts that require AltGr for `[`/`]` cannot use those shortcuts until #134
 * decides whether to add layout-aware support. The tooltip still reflects the
 * design-system key.
 */

export type ShellKeyId = 'sidebar-toggle' | 'settings-toggle' | 'close-layer' | 'pane-toggle';

/**
 * When a binding is allowed to fire:
 * - `no-text-entry`: single-key shortcut, blocked in inputs/editable elements, while
 *   a menu or dialog is open, with any modifier held, or with AltGr active.
 * - `anywhere`: fires everywhere, including inside form fields (the settings toggle).
 * - `layer-open`: Escape; the handler decides which layer to close.
 */
export type ShellKeyScope = 'no-text-entry' | 'anywhere' | 'layer-open';

export interface ShellChord {
  /** The `KeyboardEvent.key` value that triggers this chord. */
  readonly key: string;
  /** `mod` means Cmd on macOS and Ctrl elsewhere. Absent means a single key. */
  readonly mod?: 'mod';
}

export interface ShellKeyBinding {
  readonly id: ShellKeyId;
  readonly label: string;
  readonly keys: readonly ShellChord[];
  readonly appliesWhen: ShellKeyScope;
}

export const SHELL_KEYS: readonly ShellKeyBinding[] = [
  { id: 'sidebar-toggle', label: 'Sidebar', keys: [{ key: '[' }], appliesWhen: 'no-text-entry' },
  { id: 'pane-toggle', label: 'Detail pane', keys: [{ key: ']' }], appliesWhen: 'no-text-entry' },
  {
    id: 'settings-toggle',
    label: 'Settings',
    keys: [{ key: ',', mod: 'mod' }],
    appliesWhen: 'anywhere'
  },
  { id: 'close-layer', label: 'Close', keys: [{ key: 'Escape' }], appliesWhen: 'layer-open' }
];

/** Look up a binding by id. Throws if the id is unknown (a programming error). */
export function getShellKey(id: ShellKeyId): ShellKeyBinding {
  const binding = SHELL_KEYS.find((entry) => entry.id === id);
  if (binding === undefined) {
    throw new Error(`Unknown shell key id: ${id}`);
  }
  return binding;
}

/** Detect macOS so the tooltip shows glyphs (⌘) and the mod key maps to Cmd. */
export function isMacPlatform(nav: Navigator | undefined = typeof navigator !== 'undefined' ? navigator : undefined): boolean {
  if (nav === undefined) {
    return false;
  }
  const platform = nav.platform ?? '';
  const agent = nav.userAgent ?? '';
  return /mac|iphone|ipad|ipod/iu.test(platform) || /mac os x/iu.test(agent);
}

const KEY_GLYPHS: Readonly<Record<string, string>> = {
  Escape: 'Esc'
};

/** Human display text for a single chord, platform-aware (glyphs on macOS). */
export function formatChord(chord: ShellChord, isMac: boolean): string {
  const keyText = KEY_GLYPHS[chord.key] ?? chord.key;
  if (chord.mod !== 'mod') {
    return keyText;
  }
  return isMac ? `⌘${keyText}` : `Ctrl+${keyText}`;
}

/** The tooltip/README key hint for a binding (its first chord). */
export function keyHintFor(id: ShellKeyId, isMac: boolean): string {
  const [first] = getShellKey(id).keys;
  if (first === undefined) {
    return '';
  }
  return formatChord(first, isMac);
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** A minimal, testable view of the parts of a keyboard event matching needs. */
export interface ShellKeyEvent {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  getModifierState(key: string): boolean;
}

/** Whether an element is text-entry (single-key shortcuts must not fire into it). */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    return true;
  }
  if (target.isContentEditable === true) {
    return true;
  }
  // jsdom does not compute `isContentEditable` for detached nodes; fall back to the
  // IDL property and the content attribute so the guard is robust and testable.
  const ce = target.contentEditable;
  if (ce === 'true' || ce === 'plaintext-only') {
    return true;
  }
  const attr = target.getAttribute('contenteditable');
  return attr !== null && attr !== 'false' && attr !== 'inherit';
}

/** Whether a menu or dialog is currently open (blocks single-key shortcuts). */
export function isOverlayLayerOpen(doc: Document = document): boolean {
  return doc.querySelector('[role="dialog"], [role="menu"], [role="alertdialog"]') !== null;
}

export interface ShellKeyContext {
  readonly isMac: boolean;
  /** Whether focus is in a text-entry element. */
  readonly textEntry: boolean;
  /** Whether a menu/dialog layer is open. */
  readonly overlayLayerOpen: boolean;
}

function hasAltGraph(event: ShellKeyEvent): boolean {
  try {
    return event.getModifierState('AltGraph');
  } catch {
    return false;
  }
}

function modifierHeld(event: ShellKeyEvent): boolean {
  return event.metaKey || event.ctrlKey || event.altKey || hasAltGraph(event);
}

/**
 * Resolve which shell action a keyboard event triggers, or `undefined` for none.
 * Pure and fully testable: the hook maps the returned id to a handler.
 */
export function resolveShellKeyAction(
  event: ShellKeyEvent,
  ctx: ShellKeyContext
): ShellKeyId | undefined {
  // Settings toggle works everywhere, including inside form fields.
  if (event.key === ',' && (ctx.isMac ? event.metaKey : event.ctrlKey) && !event.altKey) {
    return 'settings-toggle';
  }

  // Escape is always available; the handler decides which layer to close.
  if (event.key === 'Escape') {
    return 'close-layer';
  }

  // Single-key printable shortcuts: blocked in text entry, open overlays, with any
  // modifier, or with AltGr active.
  if (ctx.textEntry || ctx.overlayLayerOpen || modifierHeld(event)) {
    return undefined;
  }
  if (event.key === '[') {
    return 'sidebar-toggle';
  }
  if (event.key === ']') {
    return 'pane-toggle';
  }
  return undefined;
}
