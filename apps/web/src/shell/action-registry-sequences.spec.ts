/**
 * Sequence candidate matching and registry conflict validation.
 *
 * `startSequenceCandidates`/`advanceSequence` are the pure core the hook's shared tracker
 * drives; `findRegistryConflicts`/`assertRegistryValid` reject duplicate bindings and
 * sequence-prefix conflicts, naming both actions. The shipped registry is proven valid.
 */
import { describe, expect, it } from 'vitest';

import {
  ACTIONS,
  advanceSequence,
  assertRegistryValid,
  findRegistryConflicts,
  startSequenceCandidates,
  type ActionContext,
  type ActionDescriptor
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

// Scripted registries use real ActionIds but arbitrary bindings for the test.
const TWO_STEP: readonly ActionDescriptor[] = [
  { id: 'open-shortcuts', name: 'g then r', keys: [[{ key: 'g' }, { key: 'r' }]], appliesWhen: 'no-text-entry' }
];

const THREE_STEP: readonly ActionDescriptor[] = [
  {
    id: 'open-shortcuts',
    name: 'g then r then t',
    keys: [[{ key: 'g' }, { key: 'r' }, { key: 't' }]],
    appliesWhen: 'no-text-entry'
  }
];

describe('startSequenceCandidates', () => {
  it('starts a candidate when the first chord of a sequence matches', () => {
    const starts = startSequenceCandidates(makeEvent({ key: 'g' }), PLAIN, TWO_STEP);
    expect(starts).toHaveLength(1);
    expect(starts[0]?.actionId).toBe('open-shortcuts');
    expect(starts[0]?.nextIndex).toBe(1);
  });

  it('starts nothing for a combo-only registry', () => {
    const combo: readonly ActionDescriptor[] = [
      { id: 'select-next', name: 'j', keys: [[{ key: 'j' }]], appliesWhen: 'no-text-entry' }
    ];
    expect(startSequenceCandidates(makeEvent({ key: 'j' }), PLAIN, combo)).toEqual([]);
  });
});

describe('advanceSequence', () => {
  it('fires a two-chord sequence on its final chord', () => {
    const [candidate] = startSequenceCandidates(makeEvent({ key: 'g' }), PLAIN, TWO_STEP);
    const result = advanceSequence([candidate!], makeEvent({ key: 'r' }), PLAIN);
    expect(result.fired).toBe('open-shortcuts');
    expect(result.consumed).toBe(true);
    expect(result.pending).toEqual([]);
  });

  it('advances a three-chord sequence step by step and fires on the last chord', () => {
    const [first] = startSequenceCandidates(makeEvent({ key: 'g' }), PLAIN, THREE_STEP);
    const afterR = advanceSequence([first!], makeEvent({ key: 'r' }), PLAIN);
    expect(afterR.fired).toBeUndefined();
    expect(afterR.consumed).toBe(true);
    expect(afterR.pending).toHaveLength(1);
    expect(afterR.pending[0]?.nextIndex).toBe(2);

    const afterT = advanceSequence(afterR.pending, makeEvent({ key: 't' }), PLAIN);
    expect(afterT.fired).toBe('open-shortcuts');
    expect(afterT.consumed).toBe(true);
  });

  it('reports a wrong key as not consumed and clears pending', () => {
    const [candidate] = startSequenceCandidates(makeEvent({ key: 'g' }), PLAIN, TWO_STEP);
    const result = advanceSequence([candidate!], makeEvent({ key: 'x' }), PLAIN);
    expect(result.consumed).toBe(false);
    expect(result.fired).toBeUndefined();
    expect(result.pending).toEqual([]);
  });

  it('drops a candidate whose action is no longer eligible (guard applies per chord)', () => {
    const [candidate] = startSequenceCandidates(makeEvent({ key: 'g' }), PLAIN, TWO_STEP);
    const blocked: ActionContext = { ...PLAIN, textEntry: true };
    const result = advanceSequence([candidate!], makeEvent({ key: 'r' }), blocked);
    expect(result.consumed).toBe(false);
    expect(result.pending).toEqual([]);
  });
});

describe('findRegistryConflicts', () => {
  it('passes the shipped registry', () => {
    expect(findRegistryConflicts(ACTIONS)).toEqual([]);
    expect(() => assertRegistryValid(ACTIONS)).not.toThrow();
  });

  it('rejects two actions that share a binding, naming both', () => {
    const registry: readonly ActionDescriptor[] = [
      { id: 'sidebar-toggle', name: 'A', keys: [[{ key: 'x' }]], appliesWhen: 'no-text-entry' },
      { id: 'pane-toggle', name: 'B', keys: [[{ key: 'x' }]], appliesWhen: 'no-text-entry' }
    ];
    const conflicts = findRegistryConflicts(registry);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toContain('sidebar-toggle');
    expect(conflicts[0]).toContain('pane-toggle');
  });

  it('rejects a combo that is also the prefix of a sequence, naming both', () => {
    const registry: readonly ActionDescriptor[] = [
      { id: 'sidebar-toggle', name: 'G', keys: [[{ key: 'g' }]], appliesWhen: 'no-text-entry' },
      { id: 'open-shortcuts', name: 'G then R', keys: [[{ key: 'g' }, { key: 'r' }]], appliesWhen: 'no-text-entry' }
    ];
    const conflicts = findRegistryConflicts(registry);
    expect(conflicts.some((message) => message.includes('sidebar-toggle') && message.includes('open-shortcuts'))).toBe(
      true
    );
    expect(() => assertRegistryValid(registry)).toThrow(/prefix/u);
  });
});
