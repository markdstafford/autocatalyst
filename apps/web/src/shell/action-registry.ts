/**
 * The action registry: the one place every keyboard-driven action is declared, with
 * its name, bindings, applies-when rule, and tooltip text. Handlers, tooltips, and the
 * shortcuts overlay all read from here, so no component hard-codes a key.
 *
 * ## Bindings
 *
 * `keys` is a list of {@link Binding}s — each an alternate for the same action. A binding
 * is a non-empty ordered list of chords: one chord is a combo, two or more is a sequence
 * (fired step by step within the sequence timeout, owned by `use-action-keys.ts`). No
 * shipped action uses a sequence yet; sequence support exists for the gallery and the
 * upcoming keyboard work, and is exercised with scripted registries in tests.
 *
 * ## Applies-when rules
 * - `no-text-entry`: blocked in inputs/editable elements and while a menu or dialog is
 *   open. Modifier requirements are now per-chord, not a blanket block.
 * - `anywhere`: fires everywhere, including inside form fields (the settings toggle).
 * - `layer-open`: Escape; the action predicate checks whether the shell owns the top layer.
 * - `list-focus`: like `no-text-entry` but additionally requires focus inside the run
 *   list (`j`/`k` and the arrows).
 */
import type { Run } from '@autocatalyst/api-contract';

import type { RunDetailTabId } from '../runs/run-detail-tabs.js';
import { isSpecGateDecisionAvailable } from '../runs/spec-decision.js';
import {
  formatBinding,
  honoursShift,
  isLetterChord,
  matchesChord,
  type Binding,
  type ShellChord,
  type ShellKeyEvent
} from './key-utils.js';

export type ActionId =
  | 'sidebar-toggle'
  | 'pane-toggle'
  | 'settings-toggle'
  | 'close-layer'
  | 'open-shortcuts'
  | 'select-next'
  | 'select-previous'
  | 'spec-gate-decision'
  | 'resolve-comment'
  | 'previous-comment'
  | 'next-comment'
  | 'expand-spec'
  | 'create-view'
  | 'rename-view'
  | 'delete-view'
  | 'previous-view'
  | 'next-view';

export type AppliesWhen = 'no-text-entry' | 'anywhere' | 'layer-open' | 'list-focus';

export interface ActionDescriptor {
  readonly id: ActionId;
  /** Human-readable action name, shown in the shortcuts overlay. */
  readonly name: string;
  /** Every binding that triggers the action; each binding is an alternate. */
  readonly keys: readonly Binding[];
  readonly appliesWhen: AppliesWhen;
  /** Additional live eligibility shared by dispatch and the conflict suite. */
  when?(ctx: ActionContext): boolean;
}

const namedView = (ctx: ActionContext): boolean => ctx.route === 'runs' && ctx.viewPosition !== undefined;
const specReady = (ctx: ActionContext): boolean =>
  ctx.run !== undefined && ctx.detailTab === 'spec' && ctx.specReady === true;
const shellAvailable = (ctx: ActionContext): boolean => ctx.startRunOpen !== true;

/** Overlay display order. Controls derive key hints from their action's bindings. */
export const ACTIONS: readonly ActionDescriptor[] = [
  { id: 'sidebar-toggle', name: 'Sidebar', keys: [[{ key: '[' }]], appliesWhen: 'no-text-entry', when: shellAvailable },
  { id: 'pane-toggle', name: 'Detail pane', keys: [[{ key: ']' }]], appliesWhen: 'no-text-entry',
    when: (ctx) => shellAvailable(ctx) && ctx.route === 'runs' },
  { id: 'settings-toggle', name: 'Settings', keys: [[{ key: ',', mod: 'mod' }]], appliesWhen: 'anywhere',
    when: (ctx) => shellAvailable(ctx) && !(ctx.route === 'settings' && ctx.settingsCheckPending === true) },
  { id: 'open-shortcuts', name: 'Keyboard shortcuts', keys: [[{ key: '?' }]], appliesWhen: 'no-text-entry', when: shellAvailable },
  { id: 'close-layer', name: 'Close', keys: [[{ key: 'Escape' }]], appliesWhen: 'layer-open',
    when: (ctx) => shellAvailable(ctx) && (ctx.shortcutsOpen === true ||
      (!ctx.overlayLayerOpen && (ctx.hoverSidebarOpen === true || (ctx.route === 'settings' && !ctx.settingsCheckPending)))) },
  { id: 'select-next', name: 'Next run', keys: [[{ key: 'j' }], [{ key: 'ArrowDown' }]], appliesWhen: 'list-focus',
    when: (ctx) => ctx.canSelectNext === true },
  { id: 'select-previous', name: 'Previous run', keys: [[{ key: 'k' }], [{ key: 'ArrowUp' }]], appliesWhen: 'list-focus',
    when: (ctx) => ctx.canSelectPrevious === true },
  { id: 'create-view', name: 'Create view', keys: [[{ key: 'n', shift: true }]], appliesWhen: 'no-text-entry', when: namedView },
  { id: 'rename-view', name: 'Rename view', keys: [[{ key: 'v', shift: true }]], appliesWhen: 'no-text-entry', when: namedView },
  { id: 'delete-view', name: 'Delete view', keys: [[{ key: 'd', shift: true }]], appliesWhen: 'no-text-entry',
    when: (ctx) => namedView(ctx) && ctx.viewPosition !== 'singleton' },
  { id: 'previous-view', name: 'Previous view', keys: [[{ key: ',', exactShift: true }]], appliesWhen: 'no-text-entry',
    when: (ctx) => namedView(ctx) && (ctx.viewPosition === 'middle' || ctx.viewPosition === 'last') },
  { id: 'next-view', name: 'Next view', keys: [[{ key: '.', exactShift: true }]], appliesWhen: 'no-text-entry',
    when: (ctx) => namedView(ctx) && (ctx.viewPosition === 'middle' || ctx.viewPosition === 'first') },
  // The decision opens a confirm popover, so it has no single-key shortcut.
  { id: 'spec-gate-decision', name: 'Spec gate decision', keys: [], appliesWhen: 'no-text-entry',
    when: (ctx) => ctx.specReady === true && ctx.run !== undefined && isSpecGateDecisionAvailable(ctx.run) },
  { id: 'resolve-comment', name: 'Resolve comment', keys: [[{ key: 'r' }]], appliesWhen: 'no-text-entry',
    when: (ctx) => specReady(ctx) && ctx.run !== undefined && isSpecGateDecisionAvailable(ctx.run) && ctx.canResolveComment === true },
  { id: 'previous-comment', name: 'Previous comment', keys: [[{ key: 'c', shift: true }]], appliesWhen: 'no-text-entry',
    when: (ctx) => specReady(ctx) && ctx.canSelectPreviousComment === true },
  { id: 'next-comment', name: 'Next comment', keys: [[{ key: 'c' }]], appliesWhen: 'no-text-entry',
    when: (ctx) => specReady(ctx) && ctx.canSelectNextComment === true },
  { id: 'expand-spec', name: 'Expand spec', keys: [[{ key: 'x' }]], appliesWhen: 'no-text-entry', when: specReady }
];

/** Look up an action by id. Throws on an unknown id (a programming error). */
export function getAction(id: ActionId): ActionDescriptor {
  const action = ACTIONS.find((entry) => entry.id === id);
  if (action === undefined) {
    throw new Error(`Unknown action id: ${id}`);
  }
  return action;
}

/** The tooltip key hint for an action (its first binding), platform-aware. */
export function actionTooltipKey(id: ActionId, isMac: boolean): string {
  const [first] = getAction(id).keys;
  return first === undefined ? '' : formatBinding(first, isMac);
}

/** All binding caps for an action, for the shortcuts overlay (platform-aware). */
export function actionKeyCaps(id: ActionId, isMac: boolean): string[] {
  return getAction(id).keys.map((binding) => formatBinding(binding, isMac));
}

/** App state contributed by the mounted shell, list, and detail key owners. */
export interface ActionState {
  readonly route?: 'runs' | 'settings' | 'other';
  readonly viewPosition?: 'singleton' | 'first' | 'middle' | 'last';
  readonly startRunOpen?: boolean;
  readonly shortcutsOpen?: boolean;
  readonly hoverSidebarOpen?: boolean;
  readonly settingsCheckPending?: boolean;
  readonly canSelectNext?: boolean;
  readonly canSelectPrevious?: boolean;
  readonly run?: Run;
  readonly detailTab?: RunDetailTabId;
  readonly specReady?: boolean;
  readonly canResolveComment?: boolean;
  readonly canSelectPreviousComment?: boolean;
  readonly canSelectNextComment?: boolean;
}

/** Context evaluated at keypress time. */
export interface ActionContext extends ActionState {
  readonly isMac: boolean;
  /** Focus is in a text-entry element. */
  readonly textEntry: boolean;
  /** A menu/dialog layer is open. */
  readonly overlayLayerOpen: boolean;
  /** Focus is inside the run list (gates `list-focus` actions). */
  readonly listFocused: boolean;
}

/** Whether an action is eligible to match at all, given the live context. */
export function isActionEligible(action: ActionDescriptor, ctx: ActionContext): boolean {
  if (action.when !== undefined && !action.when(ctx)) return false;
  switch (action.appliesWhen) {
    case 'anywhere':
    case 'layer-open':
      return true;
    case 'no-text-entry':
      return !ctx.textEntry && !ctx.overlayLayerOpen;
    case 'list-focus':
      return !ctx.textEntry && !ctx.overlayLayerOpen && ctx.listFocused;
    default:
      return false;
  }
}

/**
 * Resolve which action a single keyboard event triggers as a **combo** (one-chord
 * binding), or `undefined`. Pure and fully testable; the hook maps the returned id to a
 * handler. Sequence (multi-chord) bindings are owned by the hook's shared tracker and
 * are not resolved here. `actions` defaults to the shipped registry; tests pass scripted
 * registries.
 */
export function matchAction(
  event: ShellKeyEvent,
  ctx: ActionContext,
  actions: readonly ActionDescriptor[] = ACTIONS
): ActionId | undefined {
  for (const action of actions) {
    if (!isActionEligible(action, ctx)) {
      continue;
    }
    for (const binding of action.keys) {
      if (binding.length === 1 && matchesChord(event, binding[0], ctx.isMac)) {
        return action.id;
      }
    }
  }
  return undefined;
}

/** A sequence binding (length ≥ 2) belonging to an action, with the step cursor. */
export interface SequenceCandidate {
  readonly actionId: ActionId;
  readonly binding: Binding;
  readonly action: ActionDescriptor;
  /** The index of the next chord to match. */
  readonly nextIndex: number;
}

/**
 * Find sequence candidates started by this event: every eligible action with a
 * multi-chord binding whose first chord matches. The returned candidates point at the
 * second chord.
 */
export function startSequenceCandidates(
  event: ShellKeyEvent,
  ctx: ActionContext,
  actions: readonly ActionDescriptor[] = ACTIONS
): SequenceCandidate[] {
  const candidates: SequenceCandidate[] = [];
  for (const action of actions) {
    if (!isActionEligible(action, ctx)) {
      continue;
    }
    for (const binding of action.keys) {
      if (binding.length > 1 && matchesChord(event, binding[0], ctx.isMac)) {
        candidates.push({ actionId: action.id, binding, action, nextIndex: 1 });
      }
    }
  }
  return candidates;
}

/** The outcome of feeding one event to a set of pending sequence candidates. */
export interface SequenceAdvance {
  /** An action whose final chord just matched, if any. */
  readonly fired?: ActionId;
  /** The surviving candidates (empty when fired or reset). */
  readonly pending: SequenceCandidate[];
  /**
   * Whether the event belonged to the sequence (so the caller swallows it). When
   * `false`, the event did not continue any candidate: pending is cleared and the caller
   * re-evaluates the same event as a fresh first chord.
   */
  readonly consumed: boolean;
}

/**
 * Advance pending sequence candidates by one event. Guard rules apply to every chord:
 * a candidate whose action is no longer eligible drops out. A completed candidate fires;
 * otherwise surviving candidates advance one step. A non-matching event clears the
 * pending set and is reported as not consumed so the caller re-evaluates it fresh.
 */
export function advanceSequence(
  candidates: readonly SequenceCandidate[],
  event: ShellKeyEvent,
  ctx: ActionContext
): SequenceAdvance {
  const survivors = candidates.filter(
    (candidate) =>
      isActionEligible(candidate.action, ctx) &&
      matchesChord(event, candidate.binding[candidate.nextIndex] as ShellChord, ctx.isMac)
  );
  if (survivors.length === 0) {
    return { pending: [], consumed: false };
  }
  const completed = survivors.find((candidate) => candidate.nextIndex + 1 === candidate.binding.length);
  if (completed !== undefined) {
    return { fired: completed.actionId, pending: [], consumed: true };
  }
  return {
    pending: survivors.map((candidate) => ({ ...candidate, nextIndex: candidate.nextIndex + 1 })),
    consumed: true
  };
}

// ---------------------------------------------------------------------------
// Registry conflict validation
// ---------------------------------------------------------------------------

function chordEvents(chord: ShellChord, isMac: boolean): ShellKeyEvent[] {
  const mod = chord.mod === 'mod';
  const altKey = chord.alt === true;
  const key = isLetterChord(chord) ? chord.key.toLowerCase() : chord.key;
  return (honoursShift(chord) ? [chord.shift === true] : [false, true]).map((shiftKey) => ({
    key,
    ...(chord.code === undefined ? {} : { code: chord.code }),
    metaKey: mod && isMac,
    ctrlKey: mod && !isMac,
    altKey,
    shiftKey,
    getModifierState: () => false
  }));
}

// A concrete event that both chords accept is an overlap, even if one binding
// accepts additional Shift states or the descriptors display differently.
function chordsOverlap(a: ShellChord, b: ShellChord, isMac: boolean): boolean {
  return chordEvents(a, isMac).some((event) => matchesChord(event, b, isMac));
}

function equivalent(a: ShellChord, b: ShellChord): boolean {
  return chordEvents(a, false).every((event) => matchesChord(event, b, false)) &&
    chordEvents(b, false).every((event) => matchesChord(event, a, false));
}

function validChord(chord: ShellChord): boolean {
  return chord != null && typeof chord.key === 'string' && (chord.key === ' ' || chord.key.trim() !== '') &&
    (chord.mod === undefined || chord.mod === 'mod') &&
    (chord.code === undefined || (typeof chord.code === 'string' && chord.code.trim() !== '')) &&
    (chord.shift === undefined || typeof chord.shift === 'boolean') &&
    (chord.exactShift === undefined || typeof chord.exactShift === 'boolean') &&
    (chord.alt === undefined || typeof chord.alt === 'boolean') &&
    (!chord.alt || chord.code !== undefined) &&
    !['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'AltGraph'].includes(chord.key);
}

/** Check structure unconditionally, and cross-action overlaps only in supplied contexts. */
export function findRegistryConflicts(actions: readonly ActionDescriptor[], samples: readonly ActionContext[] = []): string[] {
  const errors: string[] = [];
  const entries: { readonly action: ActionDescriptor; readonly binding: Binding }[] = [];
  for (const action of actions) {
    for (const binding of action.keys) {
      if (!Array.isArray(binding) || binding.length === 0 || !Array.from(binding).every(validChord)) {
        errors.push(`Action "${action.id}" has a malformed binding.`);
      } else {
        entries.push({ action, binding });
      }
    }
  }

  for (const [index, entry] of entries.entries()) {
    for (const other of entries.slice(index + 1)) {
      const [a, b] = entry.binding.length <= other.binding.length ? [entry, other] : [other, entry];
      const label = formatBinding(a.binding, false);
      if (a.binding.length < b.binding.length) {
        if (a.binding.every((chord, i) => chordsOverlap(chord, b.binding[i]!, false))) {
          errors.push(`Action "${a.action.id}" binding ${label} is a prefix of action "${b.action.id}" sequence ${formatBinding(b.binding, false)}.`);
        }
      } else if (a.action.id === b.action.id) {
        if (a.binding.every((chord, i) => equivalent(chord, b.binding[i]!))) {
          errors.push(`Action "${a.action.id}" repeats binding ${label}.`);
        }
      } else {
        if (samples.length === 0) continue;
        const overlaps = (isMac: boolean): boolean =>
          a.binding.every((chord, i) => chordsOverlap(chord, b.binding[i]!, isMac));
        const mac = overlaps(true);
        const otherPlatform = overlaps(false);
        if (!mac && !otherPlatform) continue;
        const witness = samples.find((ctx) => (ctx.isMac ? mac : otherPlatform) &&
          isActionEligible(a.action, ctx) && isActionEligible(b.action, ctx));
        if (witness !== undefined) {
          errors.push(`Actions "${a.action.id}" and "${b.action.id}" both bind ${formatBinding(a.binding, witness.isMac)} in ${JSON.stringify(witness)}.`);
        }
      }
    }
  }
  return errors;
}

/** Import-time structural check only. The test suite owns the sample contexts. */
export function assertRegistryValid(actions: readonly ActionDescriptor[]): void {
  const conflicts = findRegistryConflicts(actions);
  if (conflicts.length > 0) {
    throw new Error(`Invalid shortcut registry:\n${conflicts.join('\n')}`);
  }
}

assertRegistryValid(ACTIONS);
