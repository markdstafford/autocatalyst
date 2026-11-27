/**
 * Sequence candidate matching and registry conflict validation.
 *
 * `startSequenceCandidates`/`advanceSequence` are the pure core the hook's shared tracker
 * drives; `findRegistryConflicts`/`assertRegistryValid` reject duplicate bindings and
 * sequence-prefix conflicts, naming both actions. The shipped registry is proven valid.
 */
import { runStatusSchema, waitingOnSchema } from '@autocatalyst/api-contract';
import { makeRun } from '../runs/run-fixtures.js';
import { ALL_TAB_IDS } from '../runs/run-detail-tabs.js';
import { describe, expect, it } from 'vitest';

import {
  ACTIONS,
  advanceSequence,
  assertRegistryValid,
  findRegistryConflicts,
  matchAction,
  type ActionState,
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

// Keep context samples in test code: they catch sampled overlaps, not every
// conceivable state. Include legacy runs without derived status/waiting fields.
function* detailSamples(): Iterable<ActionState> {
  yield {};
  const steps = [
    'spec.author', 'spec.awaiting_input', 'spec.human_review', 'implementation.awaiting_input',
    'implementation.human_review', 'docs.human_review', 'pr.human_review'
  ];
  const comments = [
    {},
    { canSelectNextComment: true },
    { canSelectPreviousComment: true },
    { canSelectNextComment: true, canSelectPreviousComment: true },
    { canSelectNextComment: true, canSelectPreviousComment: true, canResolveComment: true },
    { canResolveComment: true }
  ];
  for (const currentStep of steps) {
    for (const status of [undefined, ...runStatusSchema.options]) {
      for (const waitingOn of [undefined, ...waitingOnSchema.options]) {
        const run = { ...makeRun(), currentStep, status, waitingOn, terminal: status !== undefined && status !== 'in_progress' };
        for (const detailTab of ALL_TAB_IDS) {
          for (const specReady of [true, false]) {
            for (const comment of comments) yield { run, detailTab, specReady, ...comment };
          }
        }
      }
    }
  }
}

function shippedSamples(): ActionContext[] {
  const samples: ActionContext[] = [];
  const detail = [...detailSamples()];
  for (const isMac of [false, true]) {
    for (const textEntry of [false, true]) {
      for (const overlayLayerOpen of [false, true]) {
        const common = { ...PLAIN, isMac, textEntry, overlayLayerOpen };
        samples.push({ ...common, route: 'other' });
        for (const settingsCheckPending of [false, true]) {
          for (const hoverSidebarOpen of [false, true]) {
            samples.push({ ...common, route: 'settings', settingsCheckPending, hoverSidebarOpen });
          }
        }
        for (const viewPosition of ['singleton', 'first', 'middle', 'last'] as const) {
          const named = { ...common, route: 'runs', viewPosition } as const;
          samples.push({ ...named, startRunOpen: true }, { ...named, shortcutsOpen: true },
            { ...named, hoverSidebarOpen: true }, { ...named, listFocused: true });
          for (const spec of detail) {
            samples.push({ ...named, ...spec });
            if (spec.run !== undefined) {
              samples.push(
                { ...named, ...spec, listFocused: true, canSelectNext: true },
                { ...named, ...spec, listFocused: true, canSelectPrevious: true },
                { ...named, ...spec, listFocused: true, canSelectNext: true, canSelectPrevious: true }
              );
            }
          }
        }
      }
    }
  }
  return samples;
}

describe('findRegistryConflicts', () => {
  it('passes the entire shipped registry in sampled contexts', () => {
    expect(findRegistryConflicts(ACTIONS, shippedSamples())).toEqual([]);
    expect(() => assertRegistryValid(ACTIONS)).not.toThrow();
  });

  const overlapping: readonly ActionDescriptor[] = [
    { id: 'create-view', name: 'A', keys: [[{ key: 'x', mod: 'mod' }]], appliesWhen: 'no-text-entry' },
    { id: 'pane-toggle', name: 'B', keys: [[{ key: 'X', mod: 'mod', shift: false }]], appliesWhen: 'no-text-entry' }
  ];

  it('accepts structurally valid overlaps on import but rejects them with a sampled witness', () => {
    expect(() => assertRegistryValid(overlapping)).not.toThrow();
    expect(findRegistryConflicts(overlapping, [{ ...PLAIN, route: 'runs', isMac: true }]))
      .toEqual([expect.stringMatching(/create-view.*pane-toggle.*⌘x.*"route":"runs"/u)]);
  });

  it('allows disjoint shared bindings and dispatches each only in its own context', () => {
    const disjoint: readonly ActionDescriptor[] = overlapping.map((action) => ({
      ...action, when: (ctx) => ctx.route === (action.id === 'create-view' ? 'runs' : 'settings')
    }));
    const runs: ActionContext = { ...PLAIN, route: 'runs' };
    const settings: ActionContext = { ...PLAIN, route: 'settings' };
    const event = makeEvent({ key: 'x', ctrlKey: true });
    expect(() => assertRegistryValid(disjoint)).not.toThrow();
    expect(findRegistryConflicts(disjoint, [runs, settings])).toEqual([]);
    expect(matchAction(event, runs, disjoint)).toBe('create-view');
    expect(matchAction(event, settings, disjoint)).toBe('pane-toggle');
  });

  it('rejects malformed and equivalent within-action bindings without samples', () => {
    const action = overlapping[0]!;
    expect(() => assertRegistryValid([{ ...action, keys: [[{ key: 'x', alt: true }]] }])).toThrow(/malformed/u);
    expect(() => assertRegistryValid([{ ...action, keys: [[{ key: '?' }], [{ key: '?', shift: true }]] }])).toThrow(/repeats/u);
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
