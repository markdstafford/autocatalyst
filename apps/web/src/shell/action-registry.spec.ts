/**
 * Action registry tests: the declared action set, platform-aware key caps, and the
 * matcher — single-key guards, the always-on settings toggle, Escape routing, the
 * `?` shortcuts action, and the list-focus gate for `j`/`k` and the arrows.
 */
import { describe, expect, it } from 'vitest';

import {
  ACTIONS,
  actionKeyCaps,
  actionTooltipKey,
  getAction,
  matchAction,
  type ActionContext
} from './action-registry.js';
import type { ShellKeyEvent } from './key-utils.js';

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

const PLAIN: ActionContext = { isMac: false, textEntry: false, overlayLayerOpen: false, listFocused: false };
const IN_LIST: ActionContext = { ...PLAIN, listFocused: true };

describe('registry shape', () => {
  it('declares all shell and selection actions once', () => {
    const ids = ACTIONS.map((a) => a.id).sort();
    expect(ids).toEqual([
      'close-layer',
      'expand-spec',
      'next-comment',
      'open-shortcuts',
      'pane-toggle',
      'previous-comment',
      'resolve-comment',
      'select-next',
      'select-previous',
      'settings-toggle',
      'sidebar-toggle',
      'spec-gate-decision'
    ]);
  });

  it('exposes tooltip key hints and platform-aware caps', () => {
    expect(actionTooltipKey('pane-toggle', false)).toBe(']');
    expect(actionTooltipKey('settings-toggle', true)).toBe('⌘,');
    expect(actionTooltipKey('settings-toggle', false)).toBe('Ctrl+,');
    expect(actionKeyCaps('select-next', false)).toEqual(['j', '↓']);
  });

  it('throws for an unknown id', () => {
    // @ts-expect-error exercising the guard
    expect(() => getAction('nope')).toThrow();
  });
});

describe('matchAction shell actions', () => {
  it('matches sidebar and pane single keys outside text entry', () => {
    expect(matchAction(makeEvent({ key: '[' }), PLAIN)).toBe('sidebar-toggle');
    expect(matchAction(makeEvent({ key: ']' }), PLAIN)).toBe('pane-toggle');
  });

  it('matches the shortcuts action on ?', () => {
    expect(matchAction(makeEvent({ key: '?', shiftKey: true }), PLAIN)).toBe('open-shortcuts');
  });

  it('fires the settings toggle everywhere, including text entry', () => {
    expect(matchAction(makeEvent({ key: ',', ctrlKey: true }), { ...PLAIN, textEntry: true })).toBe(
      'settings-toggle'
    );
  });

  it('routes Escape to close-layer even in text entry and overlays', () => {
    expect(matchAction(makeEvent({ key: 'Escape' }), { ...PLAIN, textEntry: true, overlayLayerOpen: true })).toBe(
      'close-layer'
    );
  });

  it('blocks single-key actions in text entry, overlays, and with modifiers', () => {
    expect(matchAction(makeEvent({ key: '[' }), { ...PLAIN, textEntry: true })).toBeUndefined();
    expect(matchAction(makeEvent({ key: '[' }), { ...PLAIN, overlayLayerOpen: true })).toBeUndefined();
    expect(matchAction(makeEvent({ key: '[', ctrlKey: true }), PLAIN)).toBeUndefined();
  });
});

describe('matchAction selection actions', () => {
  it('matches j/k and arrows only when focus is in the list', () => {
    expect(matchAction(makeEvent({ key: 'j' }), IN_LIST)).toBe('select-next');
    expect(matchAction(makeEvent({ key: 'ArrowDown' }), IN_LIST)).toBe('select-next');
    expect(matchAction(makeEvent({ key: 'k' }), IN_LIST)).toBe('select-previous');
    expect(matchAction(makeEvent({ key: 'ArrowUp' }), IN_LIST)).toBe('select-previous');
  });

  it('does nothing for j/k when focus is outside the list', () => {
    expect(matchAction(makeEvent({ key: 'j' }), PLAIN)).toBeUndefined();
    expect(matchAction(makeEvent({ key: 'k' }), PLAIN)).toBeUndefined();
  });
});
