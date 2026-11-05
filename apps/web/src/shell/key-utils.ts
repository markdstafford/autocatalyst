/**
 * Generic keyboard mechanics shared by the action registry and its legacy
 * `shell-keys` adapter: platform detection, the chord/binding shapes, chord
 * formatting, the text-entry and open-overlay guards, and per-chord matching.
 *
 * These are pure mechanics — they declare no application shortcuts. The one source
 * of truth for which keys drive which actions is `action-registry.ts`.
 *
 * ## Chord model
 *
 * A {@link ShellChord} is one keyboard event shape. Letter chords are authored with a
 * lowercase `key` (`{ key: 'j' }`) and matched CapsLock-safely. Non-letter printable
 * chords (`?`, `[`) carry their printed `key` and ignore Shift, because the key value
 * already encodes Shift. A chord that names `alt` also names a physical `code` (for
 * example `KeyK`), because macOS Option changes `event.key`.
 *
 * A {@link Binding} is a non-empty ordered list of chords: one chord is a combo, two or
 * more is a sequence matched in order.
 */

export interface ShellChord {
  /** The `KeyboardEvent.key` value (lowercase for letters) that triggers this chord. */
  readonly key: string;
  /** Physical `KeyboardEvent.code`; required when `alt` is named (Option rewrites `key`). */
  readonly code?: string;
  /** `mod` means Cmd on macOS and Ctrl elsewhere. Absent means that modifier must be up. */
  readonly mod?: 'mod';
  /** Whether Shift must be held (letter/alt chords only; non-letter chords ignore Shift). */
  readonly shift?: boolean;
  /** Whether Alt/Option must be held. When set, `code` is matched instead of `key`. */
  readonly alt?: boolean;
}

/** A non-empty ordered list of chords. One chord is a combo; two or more is a sequence. */
export type Binding = readonly [ShellChord, ...ShellChord[]];

/** A minimal, testable view of the parts of a keyboard event matching needs. */
export interface ShellKeyEvent {
  readonly key: string;
  readonly code?: string;
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
    code: event.code,
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
  ArrowUp: '↑',
  ArrowLeft: '←',
  ArrowRight: '→'
};

/** Whether a chord's `key` is a single ASCII letter (matched CapsLock-safely). */
export function isLetterChord(chord: ShellChord): boolean {
  return /^[a-zA-Z]$/u.test(chord.key);
}

/** Whether a chord honours Shift exactly (letters and named-alt chords) vs ignores it. */
function honoursShift(chord: ShellChord): boolean {
  return isLetterChord(chord) || (chord.alt === true && chord.code !== undefined);
}

/** Human display text for a single chord, platform-aware (glyphs on macOS). */
export function formatChord(chord: ShellChord, isMac: boolean): string {
  const keyText = KEY_GLYPHS[chord.key] ?? chord.key;
  const parts: string[] = [];
  if (chord.mod === 'mod') {
    parts.push(isMac ? '⌘' : 'Ctrl');
  }
  if (chord.shift === true) {
    parts.push(isMac ? '⇧' : 'Shift');
  }
  if (chord.alt === true) {
    parts.push(isMac ? '⌥' : 'Alt');
  }
  parts.push(keyText);
  return isMac ? parts.join('') : parts.join('+');
}

/**
 * Display text for a whole binding. A combo is its chord; a sequence joins its chords
 * with ` then ` (the shortcut display components render that separator visually).
 */
export function formatBinding(binding: Binding, isMac: boolean): string {
  return binding.map((chord) => formatChord(chord, isMac)).join(' then ');
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

/**
 * Exact per-chord match. Replaces the old blanket "any modifier blocks" guard: `mod`,
 * `shift`, and `alt` are each compared exactly against the event.
 *
 * - `mod`: the platform modifier (Cmd on macOS, Ctrl elsewhere) must match; the opposite
 *   platform modifier must never stand in for it.
 * - `alt`: must match; a named-alt chord compares the physical `code` because Option
 *   rewrites `event.key` on macOS. AltGraph is always blocked.
 * - letter chords match `event.key.toLowerCase()` (CapsLock-safe) and require exact Shift;
 *   non-letter printable chords compare `event.key` and ignore Shift.
 */
export function matchesChord(event: ShellKeyEvent, chord: ShellChord, isMac: boolean): boolean {
  const modHeld = isMac ? event.metaKey : event.ctrlKey;
  if (modHeld !== (chord.mod === 'mod')) {
    return false;
  }
  // The opposite-platform modifier must not act as `mod`.
  const otherModHeld = isMac ? event.ctrlKey : event.metaKey;
  if (otherModHeld) {
    return false;
  }
  if (event.altKey !== (chord.alt === true)) {
    return false;
  }
  if (hasAltGraph(event)) {
    return false;
  }
  if (!keyPartMatches(event, chord)) {
    return false;
  }
  if (honoursShift(chord) && event.shiftKey !== (chord.shift === true)) {
    return false;
  }
  return true;
}

function keyPartMatches(event: ShellKeyEvent, chord: ShellChord): boolean {
  if (chord.alt === true && chord.code !== undefined) {
    // Option rewrites event.key on macOS; match the physical code instead.
    return event.code === chord.code;
  }
  if (isLetterChord(chord)) {
    return event.key.toLowerCase() === chord.key.toLowerCase();
  }
  return event.key === chord.key;
}
