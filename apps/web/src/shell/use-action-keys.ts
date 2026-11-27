/**
 * Window-level keyboard dispatch driven by the action registry.
 *
 * A component passes the subset of actions it owns; each keydown resolves against the
 * registry (evaluating the live text-entry, open-overlay, and run-list focus context)
 * and invokes the matching handler.
 *
 * ## One shared owner
 *
 * Every mounted `useActionKeys` instance registers its handlers with a single
 * module-level dispatcher that attaches exactly one window `keydown` listener and owns
 * the one pending-sequence tracker. This guarantees multiple mounted instances cannot
 * maintain conflicting pending states: every keydown passes through the shared owner
 * once, and a completing sequence resolves its handler across all registered instances.
 * Combos still work exactly as before.
 */
import { useEffect, useRef } from 'react';

import {
  advanceSequence,
  matchAction,
  startSequenceCandidates,
  type ActionContext,
  type ActionDescriptor,
  type ActionId,
  type ActionState,
  type SequenceCandidate,
  ACTIONS
} from './action-registry.js';
import {
  isMacPlatform,
  isOverlayLayerOpen,
  isTextEntryTarget,
  toShellKeyEvent,
  type ShellKeyEvent
} from './key-utils.js';

/** The attribute marking the run-list container, used to detect list focus. */
export const RUN_LIST_FOCUS_ATTR = 'data-run-list';

/** The window a pending sequence step must arrive in before the prefix is cleared. */
export const SEQUENCE_TIMEOUT_MS = 1000;

/** Whether focus currently sits inside the run list. */
export function isFocusInRunList(doc: Document = document): boolean {
  const active = doc.activeElement;
  return active instanceof Element && active.closest(`[${RUN_LIST_FOCUS_ATTR}]`) !== null;
}

export type ActionHandlers = Partial<Record<ActionId, () => void>>;

export interface UseActionKeysOptions {
  /** Test seam: the registry to match against. Defaults to the shipped `ACTIONS`. */
  readonly registry?: readonly ActionDescriptor[];
  getState?(): ActionState;
}

// ---------------------------------------------------------------------------
// Shared module-level dispatcher
// ---------------------------------------------------------------------------

interface KeyOwner {
  handlers(): ActionHandlers;
  getState(): ActionState | undefined;
}

const owners = new Set<KeyOwner>();
let dispatchRegistry: readonly ActionDescriptor[] = ACTIONS;
let pendingCandidates: SequenceCandidate[] = [];
let sequenceTimer: ReturnType<typeof setTimeout> | undefined;
let listening = false;

const MODIFIER_KEYS: ReadonlySet<string> = new Set([
  'Shift',
  'Control',
  'Alt',
  'Meta',
  'CapsLock',
  'AltGraph'
]);

function resolveHandler(actionId: ActionId): (() => void) | undefined {
  for (const owner of owners) {
    const handler = owner.handlers()[actionId];
    if (handler !== undefined) {
      return handler;
    }
  }
  return undefined;
}

function clearPending(): void {
  pendingCandidates = [];
  if (sequenceTimer !== undefined) {
    clearTimeout(sequenceTimer);
    sequenceTimer = undefined;
  }
}

function armTimer(): void {
  if (sequenceTimer !== undefined) {
    clearTimeout(sequenceTimer);
  }
  sequenceTimer = setTimeout(() => {
    pendingCandidates = [];
    sequenceTimer = undefined;
  }, SEQUENCE_TIMEOUT_MS);
}

function fire(actionId: ActionId, dom: KeyboardEvent): void {
  const handler = resolveHandler(actionId);
  if (handler === undefined) {
    return;
  }
  dom.preventDefault();
  handler();
}

function dispatch(event: ShellKeyEvent, ctx: ActionContext, dom: KeyboardEvent): void {
  // A bare modifier keydown never matches and must not disturb a pending sequence.
  if (MODIFIER_KEYS.has(event.key)) {
    return;
  }

  if (pendingCandidates.length > 0) {
    const result = advanceSequence(pendingCandidates.filter((candidate) => resolveHandler(candidate.actionId) !== undefined), event, ctx);
    if (result.consumed) {
      if (result.fired !== undefined) {
        clearPending();
        fire(result.fired, dom);
      } else {
        pendingCandidates = result.pending;
        armTimer();
        dom.preventDefault();
      }
      return;
    }
    // Wrong key, Escape, or a failed guard: clear and evaluate this event as fresh.
    clearPending();
  }

  const bound = dispatchRegistry.filter(({ id }) => resolveHandler(id) !== undefined);
  const combo = matchAction(event, ctx, bound);
  if (combo !== undefined) {
    fire(combo, dom);
    return;
  }

  const starts = startSequenceCandidates(event, ctx, bound);
  if (starts.length > 0) {
    pendingCandidates = starts;
    armTimer();
    dom.preventDefault();
  }
}

function onWindowKeyDown(dom: KeyboardEvent): void {
  const state = Object.assign({}, ...[...owners].map((owner) => owner.getState())) as ActionState;
  const ctx: ActionContext = {
    ...state,
    isMac: isMacPlatform(),
    textEntry: isTextEntryTarget(dom.target),
    overlayLayerOpen: isOverlayLayerOpen(),
    listFocused: isFocusInRunList()
  };
  dispatch(toShellKeyEvent(dom), ctx, dom);
}

function ensureListening(): void {
  if (!listening) {
    window.addEventListener('keydown', onWindowKeyDown);
    listening = true;
  }
}

function maybeStopListening(): void {
  if (listening && owners.size === 0) {
    window.removeEventListener('keydown', onWindowKeyDown);
    listening = false;
    clearPending();
    dispatchRegistry = ACTIONS;
  }
}

export function useActionKeys(handlers: ActionHandlers, options?: UseActionKeysOptions): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const owner: KeyOwner = {
      handlers: () => handlersRef.current,
      getState: () => optionsRef.current?.getState?.()
    };
    owners.add(owner);
    if (optionsRef.current?.registry !== undefined) {
      dispatchRegistry = optionsRef.current.registry;
    }
    ensureListening();
    return () => {
      owners.delete(owner);
      maybeStopListening();
    };
  }, []);
}
