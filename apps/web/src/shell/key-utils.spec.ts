/**
 * Chord-matching mechanics (`matchesChord`) and formatting (`formatChord`/`formatBinding`).
 *
 * These cover the precise rules the shortcut model depends on: lowercase-authored letter
 * chords matched CapsLock-safely, Shift distinguished for letters but ignored for printable
 * non-letters (`?`), exact `mod`/`alt` comparison (so `Cmd+Shift+K` needs every named
 * modifier), Alt chords matched by physical `code` because Option rewrites `event.key` on
 * macOS, the opposite-platform modifier never standing in for `mod`, and AltGraph always
 * blocked.
 */
import { describe, expect, it } from 'vitest';

import {
  formatBinding,
  formatChord,
  isLetterChord,
  matchesChord,
  type Binding,
  type ShellChord,
  type ShellKeyEvent
} from './key-utils.js';

function makeEvent(partial: Partial<ShellKeyEvent> & { key: string }): ShellKeyEvent {
  return {
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    getModifierState: () => false,
    ...partial
  };
}

describe('letter chords distinguish Shift', () => {
  const plainJ: ShellChord = { key: 'j' };
  const shiftJ: ShellChord = { key: 'j', shift: true };

  it('plain j matches { key: j } and not { key: j, shift }', () => {
    const event = makeEvent({ key: 'j', shiftKey: false });
    expect(matchesChord(event, plainJ, false)).toBe(true);
    expect(matchesChord(event, shiftJ, false)).toBe(false);
  });

  it('Shift+J matches { key: j, shift } and not { key: j }', () => {
    const event = makeEvent({ key: 'J', shiftKey: true });
    expect(matchesChord(event, shiftJ, false)).toBe(true);
    expect(matchesChord(event, plainJ, false)).toBe(false);
  });

  it('is CapsLock-safe: plain J (CapsLock, no Shift) still matches { key: j }', () => {
    const event = makeEvent({ key: 'J', shiftKey: false });
    expect(matchesChord(event, plainJ, false)).toBe(true);
    expect(matchesChord(event, shiftJ, false)).toBe(false);
  });
});

describe('non-letter printable chords ignore Shift', () => {
  it('? matches even though Shift is physically held', () => {
    const question: ShellChord = { key: '?' };
    expect(matchesChord(makeEvent({ key: '?', shiftKey: true }), question, false)).toBe(true);
    expect(matchesChord(makeEvent({ key: '?', shiftKey: false }), question, false)).toBe(true);
  });
});

describe('exact modifier comparison', () => {
  const cmdShiftK: ShellChord = { key: 'k', mod: 'mod', shift: true };

  it('Cmd+Shift+K requires meta and shift on macOS', () => {
    expect(matchesChord(makeEvent({ key: 'K', metaKey: true, shiftKey: true }), cmdShiftK, true)).toBe(true);
    // Missing Shift.
    expect(matchesChord(makeEvent({ key: 'k', metaKey: true, shiftKey: false }), cmdShiftK, true)).toBe(false);
    // Missing the platform modifier.
    expect(matchesChord(makeEvent({ key: 'K', metaKey: false, shiftKey: true }), cmdShiftK, true)).toBe(false);
  });

  it('an unnamed mod means the platform modifier must be up', () => {
    const bracket: ShellChord = { key: '[' };
    expect(matchesChord(makeEvent({ key: '[', metaKey: true }), bracket, true)).toBe(false);
    expect(matchesChord(makeEvent({ key: '[' }), bracket, true)).toBe(true);
  });

  it('the opposite-platform modifier never stands in for mod', () => {
    const settings: ShellChord = { key: ',', mod: 'mod' };
    // On macOS, Ctrl must not satisfy a mod chord.
    expect(matchesChord(makeEvent({ key: ',', ctrlKey: true }), settings, true)).toBe(false);
    // On other platforms, Meta must not satisfy a mod chord.
    expect(matchesChord(makeEvent({ key: ',', metaKey: true }), settings, false)).toBe(false);
    // The correct platform modifier matches.
    expect(matchesChord(makeEvent({ key: ',', metaKey: true }), settings, true)).toBe(true);
    expect(matchesChord(makeEvent({ key: ',', ctrlKey: true }), settings, false)).toBe(true);
  });

  it('an unnamed alt means Alt must be up', () => {
    const bracket: ShellChord = { key: '[' };
    expect(matchesChord(makeEvent({ key: '[', altKey: true }), bracket, false)).toBe(false);
  });
});

describe('Alt chords match the physical code', () => {
  const altK: ShellChord = { key: 'k', code: 'KeyK', alt: true };

  it('matches by code even when Option rewrites event.key on macOS', () => {
    // macOS Option+K yields event.key '˚' but event.code 'KeyK'.
    const event = makeEvent({ key: '˚', code: 'KeyK', altKey: true });
    expect(matchesChord(event, altK, true)).toBe(true);
  });

  it('does not match a different physical code', () => {
    const event = makeEvent({ key: '∆', code: 'KeyJ', altKey: true });
    expect(matchesChord(event, altK, true)).toBe(false);
  });

  it('requires Alt to be held', () => {
    const event = makeEvent({ key: 'k', code: 'KeyK', altKey: false });
    expect(matchesChord(event, altK, true)).toBe(false);
  });
});

describe('AltGraph is always blocked', () => {
  it('rejects a match when AltGraph is reported', () => {
    const question: ShellChord = { key: '?' };
    const event = makeEvent({ key: '?', getModifierState: (name) => name === 'AltGraph' });
    expect(matchesChord(event, question, false)).toBe(false);
  });
});

describe('formatting', () => {
  it('detects letter chords', () => {
    expect(isLetterChord({ key: 'j' })).toBe(true);
    expect(isLetterChord({ key: '?' })).toBe(false);
    expect(isLetterChord({ key: 'ArrowDown' })).toBe(false);
  });

  it('formats modifiers as glyphs on macOS and words elsewhere', () => {
    const chord: ShellChord = { key: 'k', mod: 'mod', shift: true };
    expect(formatChord(chord, true)).toBe('⌘⇧k');
    expect(formatChord(chord, false)).toBe('Ctrl+Shift+k');
  });

  it('formats arrow glyphs and sequences', () => {
    expect(formatChord({ key: 'ArrowDown' }, false)).toBe('↓');
    const sequence: Binding = [{ key: 'g' }, { key: 'r' }];
    expect(formatBinding(sequence, false)).toBe('g then r');
  });
});
