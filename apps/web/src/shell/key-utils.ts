/**
 * Generic keyboard mechanics shared by the action registry and its legacy
 * `shell-keys` adapter: platform detection, chord shape and formatting, the
 * text-entry and open-overlay guards, and modifier detection.
 *
 * These are pure mechanics — they declare no application shortcuts. The one source
 * of truth for which keys drive which actions is `action-registry.ts`.
 */

export interface ShellChord {
  /** The `KeyboardEvent.key` value that triggers this chord. */
  readonly key: string;
  /** `mod` means Cmd on macOS and Ctrl elsewhere. Absent means a single key. */
  readonly mod?: 'mod';
}

/** A minimal, testable view of the parts of a keyboard event matching needs. */
export interface ShellKeyEvent {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  getModifierState(key: string): boolean;
}

/** Convert a DOM keyboard event into the minimal matcher shape. */
export function toShellKeyEvent(event: KeyboardEvent): ShellKeyEvent {
  return {
    key: event.key,
    metaKey: event.metaKey,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
    getModifierState: (k) => event.getModifierState(k)
  };
}

/** Detect macOS so hints show glyphs (⌘) and the mod key maps to Cmd. */
export function isMacPlatform(
  nav: Navigator | undefined = typeof navigator !== 'undefined' ? navigator : undefined
): boolean {
  if (nav === undefined) {
    return false;
  }
  const platform = nav.platform ?? '';
  const agent = nav.userAgent ?? '';
  return /mac|iphone|ipad|ipod/iu.test(platform) || /mac os x/iu.test(agent);
}

const KEY_GLYPHS: Readonly<Record<string, string>> = {
  Escape: 'Esc',
  ArrowDown: '↓',
  ArrowUp: '↑'
};

/** Human display text for a single chord, platform-aware (glyphs on macOS). */
export function formatChord(chord: ShellChord, isMac: boolean): string {
  const keyText = KEY_GLYPHS[chord.key] ?? chord.key;
  if (chord.mod !== 'mod') {
    return keyText;
  }
  return isMac ? `⌘${keyText}` : `Ctrl+${keyText}`;
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

function hasAltGraph(event: ShellKeyEvent): boolean {
  try {
    return event.getModifierState('AltGraph');
  } catch {
    return false;
  }
}

/** Whether a non-shift modifier is held (shift is allowed so `?` and caps still fire). */
export function modifierHeld(event: ShellKeyEvent): boolean {
  return event.metaKey || event.ctrlKey || event.altKey || hasAltGraph(event);
}
