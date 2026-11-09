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
 * - `layer-open`: Escape; the handler decides which layer to close. Eligible even in
 *   text entry and open overlays.
 * - `list-focus`: like `no-text-entry` but additionally requires focus inside the run
 *   list (`j`/`k` and the arrows).
 */
import {
  formatBinding,
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
  | 'expand-spec';

export type AppliesWhen = 'no-text-entry' | 'anywhere' | 'layer-open' | 'list-focus';

export interface ActionDescriptor {
  readonly id: ActionId;
  /** Human-readable action name, shown in the shortcuts overlay. */
  readonly name: string;
  /** Every binding that triggers the action; each binding is an alternate. */
  readonly keys: readonly Binding[];
  readonly appliesWhen: AppliesWhen;
}

/**
 * The registry, in overlay display order. Shell actions first, then selection. The
 * tooltip text for a control is composed from `name` + the first binding via
 * {@link actionTooltipKey}; components never pass their own key strings.
 */
export const ACTIONS: readonly ActionDescriptor[] = [
  { id: 'sidebar-toggle', name: 'Sidebar', keys: [[{ key: '[' }]], appliesWhen: 'no-text-entry' },
  { id: 'pane-toggle', name: 'Detail pane', keys: [[{ key: ']' }]], appliesWhen: 'no-text-entry' },
  { id: 'settings-toggle', name: 'Settings', keys: [[{ key: ',', mod: 'mod' }]], appliesWhen: 'anywhere' },
  { id: 'open-shortcuts', name: 'Keyboard shortcuts', keys: [[{ key: '?' }]], appliesWhen: 'no-text-entry' },
  { id: 'close-layer', name: 'Close', keys: [[{ key: 'Escape' }]], appliesWhen: 'layer-open' },
  { id: 'select-next', name: 'Next run', keys: [[{ key: 'j' }], [{ key: 'ArrowDown' }]], appliesWhen: 'list-focus' },
  { id: 'select-previous', name: 'Previous run', keys: [[{ key: 'k' }], [{ key: 'ArrowUp' }]], appliesWhen: 'list-focus' },
  // Spec-gate actions. The decision opens a destructive confirm popover, so it has no single-key
  // shortcut and no key hint. The lifecycle/navigation actions use single keys and are suppressed in
  // text entry, menus, and dialogs (including the expanded spec overlay). Beyond the focus-context
  // guard, the handlers registered in the run-detail pane apply run/spec guards (they no-op when the
  // Spec tab is not active, the run is not at the gate, or no comment is selected/resolvable).
  { id: 'spec-gate-decision', name: 'Spec gate decision', keys: [], appliesWhen: 'no-text-entry' },
  { id: 'resolve-comment', name: 'Resolve comment', keys: [[{ key: 'r' }]], appliesWhen: 'no-text-entry' },
  { id: 'previous-comment', name: 'Previous comment', keys: [[{ key: 'c', shift: true }]], appliesWhen: 'no-text-entry' },
  { id: 'next-comment', name: 'Next comment', keys: [[{ key: 'c' }]], appliesWhen: 'no-text-entry' },
  { id: 'expand-spec', name: 'Expand spec', keys: [[{ key: 'x' }]], appliesWhen: 'no-text-entry' }
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

/** Context evaluated at keypress time. */
export interface ActionContext {
  readonly isMac: boolean;
  /** Focus is in a text-entry element. */
  readonly textEntry: boolean;
  /** A menu/dialog layer is open. */
  readonly overlayLayerOpen: boolean;
  /** Focus is inside the run list (gates `list-focus` actions). */
  readonly listFocused: boolean;
}

/** Whether an action is eligible to match at all, given the live context. */
export function isActionEligible(appliesWhen: AppliesWhen, ctx: ActionContext): boolean {
  switch (appliesWhen) {
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
    if (!isActionEligible(action.appliesWhen, ctx)) {
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
  readonly appliesWhen: AppliesWhen;
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
    if (!isActionEligible(action.appliesWhen, ctx)) {
      continue;
    }
    for (const binding of action.keys) {
      if (binding.length > 1 && matchesChord(event, binding[0], ctx.isMac)) {
        candidates.push({ actionId: action.id, binding, appliesWhen: action.appliesWhen, nextIndex: 1 });
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
      isActionEligible(candidate.appliesWhen, ctx) &&
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

function chordKey(chord: ShellChord): string {
  return [chord.key, chord.code ?? '', chord.mod ?? '', chord.shift === true ? 'S' : '', chord.alt === true ? 'A' : ''].join(
    '|'
  );
}

function bindingKey(binding: Binding): string {
  return binding.map(chordKey).join('>>');
}

function isPrefixOf(shorter: Binding, longer: Binding): boolean {
  if (shorter.length >= longer.length) {
    return false;
  }
  return shorter.every((chord, index) => chordKey(chord) === chordKey(longer[index] as ShellChord));
}

/**
 * Return a deterministic list of conflict messages for a registry. Two kinds of conflict
 * are rejected, each message naming both actions:
 * - two actions share an identical binding;
 * - one action's complete binding is the prefix of another action's sequence.
 * An empty list means the registry is valid.
 */
export function findRegistryConflicts(actions: readonly ActionDescriptor[]): string[] {
  const errors: string[] = [];

  const seen = new Map<string, ActionId>();
  for (const action of actions) {
    for (const binding of action.keys) {
      const key = bindingKey(binding);
      const prior = seen.get(key);
      if (prior !== undefined) {
        errors.push(
          `Actions "${prior}" and "${action.id}" both bind ${formatBinding(binding, false)}.`
        );
      } else {
        seen.set(key, action.id);
      }
    }
  }

  for (const action of actions) {
    for (const binding of action.keys) {
      for (const other of actions) {
        for (const otherBinding of other.keys) {
          if (isPrefixOf(binding, otherBinding)) {
            errors.push(
              `Action "${action.id}" binding ${formatBinding(binding, false)} is a prefix of action ` +
                `"${other.id}" sequence ${formatBinding(otherBinding, false)}.`
            );
          }
        }
      }
    }
  }

  return errors;
}

/** Throw if a registry has conflicts, naming each one. */
export function assertRegistryValid(actions: readonly ActionDescriptor[]): void {
  const conflicts = findRegistryConflicts(actions);
  if (conflicts.length > 0) {
    throw new Error(`Invalid shortcut registry:\n${conflicts.join('\n')}`);
  }
}

// Fail fast at module load if the shipped registry ever develops a conflict.
assertRegistryValid(ACTIONS);
