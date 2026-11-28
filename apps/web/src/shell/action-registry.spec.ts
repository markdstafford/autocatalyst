/**
 * Action registry tests: the declared action set, platform-aware key caps, and the
 * matcher — single-key guards, the always-on settings toggle, Escape routing, the
 * `?` shortcuts action, and the list-focus gate for `j`/`k` and the arrows.
 */
import { describe, expect, it } from 'vitest';

import { makeRun } from '../runs/run-fixtures.js';
import {
  ACTIONS,
  RUN_ACTIONS,
  actionApplies,
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

const PLAIN: ActionContext = { isMac: false, textEntry: false, overlayLayerOpen: false, listFocused: false, route: 'runs', shortcutsOpen: true };
const IN_LIST: ActionContext = { ...PLAIN, listFocused: true, canSelectNext: true, canSelectPrevious: true };

describe('run action eligibility', () => {
  it.each([
    ['in_progress', false, false, ['Cancel', 'Rename']],
    ['in_progress', false, true, ['Cancel', 'Rename', 'Set step']],
    ['done', false, false, ['Archive', 'Rename']],
    ['failed', false, false, ['Recover', 'Archive', 'Rename']],
    ['canceled', false, false, ['Archive', 'Rename']],
    ['done', true, false, ['Unarchive', 'Rename']],
    ['failed', true, false, ['Unarchive', 'Rename']],
    [undefined, false, false, []]
  ] as const)('uses the same matrix for %s (archived=%s, history=%s)', (status, archived, hasStepCandidates, expected) => {
    const run = status === undefined ? undefined : {
      ...makeRun({ status }), ...(archived ? { archivedAt: '2026-01-02T00:00:00Z' } : {})
    };
    const ctx = { ...PLAIN, ...(run === undefined ? {} : { run }), hasStepCandidates };
    expect(RUN_ACTIONS.filter(action => actionApplies(action, ctx)).map(action => action.name)).toEqual(expected);
    expect(RUN_ACTIONS.filter(action => action.keys.some(([chord]) => matchAction(
      makeEvent({ key: chord.key, shiftKey: chord.shift === true }), ctx
    ) === action.id)).map(action => action.name)).toEqual(expected);
  });

  it('guards layers, text entry, modifiers and archive navigation without a run', () => {
    const event = makeEvent({ key: 'A', shiftKey: true });
    expect(matchAction(event, PLAIN)).toBe('show-archived-runs');
    expect(matchAction(event, { ...PLAIN, archivedOnly: true })).toBeUndefined();
    expect(matchAction(event, { ...PLAIN, overlayLayerOpen: true })).toBeUndefined();
    expect(matchAction(event, { ...PLAIN, textEntry: true })).toBeUndefined();
    expect(matchAction({ ...event, metaKey: true }, PLAIN)).toBeUndefined();
    expect(actionTooltipKey('cancel-run', true)).toBe('⇧X');
    expect(actionTooltipKey('cancel-run', false)).toBe('Shift+X');
  });
});

describe('registry shape', () => {
  it('declares all shell and selection actions once', () => {
    const ids = ACTIONS.map((a) => a.id).sort();
    expect(ids).toEqual([
      'archive-run',
      'cancel-run',
      'close-layer',
      'create-view',
      'delete-view',
      'expand-spec',
      'next-comment',
      'next-view',
      'open-shortcuts',
      'pane-toggle',
      'previous-comment',
      'previous-view',
      'recover-run',
      'rename-run',
      'rename-view',
      'resolve-comment',
      'select-next',
      'select-previous',
      'set-run-step',
      'settings-toggle',
      'show-archived-runs',
      'sidebar-toggle',
      'spec-gate-decision',
      'unarchive-run'
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

describe('named view bindings', () => {
  it.each([
    ['N', true, 'create-view'], ['V', true, 'rename-view'], ['D', true, 'delete-view'],
    [',', false, 'previous-view'], ['.', false, 'next-view']
  ])('guards %s by route, focus and overlay state', (key, shiftKey, id) => {
    const ctx: ActionContext = { ...PLAIN, viewPosition: 'middle' };
    const event = makeEvent({ key, shiftKey });
    expect(matchAction(event, ctx)).toBe(id);
    for (const patch of [{ route: 'settings' }, { route: 'other' }, { textEntry: true }, { overlayLayerOpen: true }] as const) {
      expect(matchAction(event, { ...ctx, ...patch })).toBeUndefined();
    }
  });

  it('does not wrap, does not delete a singleton, and reserves modified comma for Settings', () => {
    const first: ActionContext = { ...PLAIN, viewPosition: 'first' };
    const last: ActionContext = { ...PLAIN, viewPosition: 'last' };
    expect(matchAction(makeEvent({ key: ',' }), first)).toBeUndefined();
    expect(matchAction(makeEvent({ key: '.' }), last)).toBeUndefined();
    expect(matchAction(makeEvent({ key: 'D', shiftKey: true }), { ...first, viewPosition: 'singleton' })).toBeUndefined();
    for (const key of [',', '.']) {
      for (const modifier of [{ shiftKey: true }, { altKey: true }, { getModifierState: () => true }]) {
        expect(matchAction(makeEvent({ key, ...modifier }), { ...PLAIN, viewPosition: 'middle' })).toBeUndefined();
      }
    }
    expect(matchAction(makeEvent({ key: ',', ctrlKey: true }), { ...last, textEntry: true })).toBe('settings-toggle');
    expect(matchAction(makeEvent({ key: ',', metaKey: true }), { ...last, textEntry: true, isMac: true })).toBe('settings-toggle');
  });
});
