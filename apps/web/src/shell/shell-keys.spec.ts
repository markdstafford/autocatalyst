/**
 * Shell key table and matcher tests: tooltip key text derives from the table,
 * platform glyphs, and the single-key shortcut guards (text entry, open overlay,
 * modifiers, AltGr), the always-on settings toggle, and Escape priority routing.
 */
import { describe, expect, it } from 'vitest';

import {
  SHELL_KEYS,
  formatChord,
  getShellKey,
  isTextEntryTarget,
  keyHintFor,
  resolveShellKeyAction,
  type ShellKeyContext,
  type ShellKeyEvent
} from './shell-keys.js';

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

const PLAIN: ShellKeyContext = { isMac: false, textEntry: false, overlayLayerOpen: false };

describe('shell key table', () => {
  it('defines sidebar, pane, settings, and close bindings with the registry shape', () => {
    const ids = SHELL_KEYS.map((entry) => entry.id).sort();
    expect(ids).toEqual(['close-layer', 'pane-toggle', 'settings-toggle', 'sidebar-toggle']);
    for (const binding of SHELL_KEYS) {
      expect(typeof binding.id).toBe('string');
      expect(typeof binding.label).toBe('string');
      expect(binding.keys.length).toBeGreaterThan(0);
      expect(typeof binding.appliesWhen).toBe('string');
    }
  });

  it('derives tooltip key hints from the table', () => {
    expect(keyHintFor('sidebar-toggle', false)).toBe('[');
    expect(keyHintFor('pane-toggle', false)).toBe(']');
  });

  it('formats the settings chord with a glyph on macOS and spelled keys elsewhere', () => {
    const [chord] = getShellKey('settings-toggle').keys;
    expect(chord).toBeDefined();
    if (chord === undefined) return;
    expect(formatChord(chord, true)).toBe('⌘,');
    expect(formatChord(chord, false)).toBe('Ctrl+,');
  });
});

describe('resolveShellKeyAction', () => {
  it('toggles the sidebar on "[" with no modifiers outside text entry', () => {
    expect(resolveShellKeyAction(makeEvent({ key: '[' }), PLAIN)).toBe('sidebar-toggle');
  });

  it('resolves "]" to the pane toggle (handler no-ops it)', () => {
    expect(resolveShellKeyAction(makeEvent({ key: ']' }), PLAIN)).toBe('pane-toggle');
  });

  it('does not fire "[" in a text-entry element', () => {
    expect(
      resolveShellKeyAction(makeEvent({ key: '[' }), { ...PLAIN, textEntry: true })
    ).toBeUndefined();
  });

  it('does not fire "[" while a menu or dialog is open', () => {
    expect(
      resolveShellKeyAction(makeEvent({ key: '[' }), { ...PLAIN, overlayLayerOpen: true })
    ).toBeUndefined();
  });

  it('does not fire "[" with a modifier held', () => {
    expect(resolveShellKeyAction(makeEvent({ key: '[', ctrlKey: true }), PLAIN)).toBeUndefined();
    expect(resolveShellKeyAction(makeEvent({ key: '[', metaKey: true }), PLAIN)).toBeUndefined();
    expect(resolveShellKeyAction(makeEvent({ key: '[', altKey: true }), PLAIN)).toBeUndefined();
  });

  it('does not fire "[" when AltGr is active', () => {
    const altGr = makeEvent({ key: '[', getModifierState: (k) => k === 'AltGraph' });
    expect(resolveShellKeyAction(altGr, PLAIN)).toBeUndefined();
  });

  it('fires the settings toggle with Ctrl+, off macOS, even inside a text field', () => {
    expect(
      resolveShellKeyAction(makeEvent({ key: ',', ctrlKey: true }), { ...PLAIN, textEntry: true })
    ).toBe('settings-toggle');
  });

  it('fires the settings toggle with Cmd+, on macOS, not Ctrl+,', () => {
    const mac = { ...PLAIN, isMac: true };
    expect(resolveShellKeyAction(makeEvent({ key: ',', metaKey: true }), mac)).toBe('settings-toggle');
    expect(resolveShellKeyAction(makeEvent({ key: ',', ctrlKey: true }), mac)).toBeUndefined();
  });

  it('routes Escape to close-layer even in text entry', () => {
    expect(
      resolveShellKeyAction(makeEvent({ key: 'Escape' }), { ...PLAIN, textEntry: true })
    ).toBe('close-layer');
  });
});

describe('isTextEntryTarget', () => {
  it('detects inputs, textareas, selects, and contenteditable', () => {
    const input = document.createElement('input');
    const textarea = document.createElement('textarea');
    const select = document.createElement('select');
    const div = document.createElement('div');
    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    expect(isTextEntryTarget(input)).toBe(true);
    expect(isTextEntryTarget(textarea)).toBe(true);
    expect(isTextEntryTarget(select)).toBe(true);
    expect(isTextEntryTarget(div)).toBe(false);
    expect(isTextEntryTarget(editable)).toBe(true);
    expect(isTextEntryTarget(null)).toBe(false);
  });
});
