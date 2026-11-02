/**
 * Window-level keyboard dispatch driven by the action registry.
 *
 * A component passes the subset of actions it owns; the hook resolves each keydown
 * against the registry (evaluating the live text-entry, open-overlay, and run-list
 * focus context) and invokes the matching handler. Multiple instances coexist
 * because each handles a disjoint set of actions, so the shell and the run list can
 * each own their keys without a second key table.
 */
import { useEffect, useRef } from 'react';

import { matchAction, type ActionId } from './action-registry.js';
import {
  isMacPlatform,
  isOverlayLayerOpen,
  isTextEntryTarget,
  toShellKeyEvent
} from './key-utils.js';

/** The attribute marking the run-list container, used to detect list focus. */
export const RUN_LIST_FOCUS_ATTR = 'data-run-list';

/** Whether focus currently sits inside the run list. */
export function isFocusInRunList(doc: Document = document): boolean {
  const active = doc.activeElement;
  return active instanceof Element && active.closest(`[${RUN_LIST_FOCUS_ATTR}]`) !== null;
}

export type ActionHandlers = Partial<Record<ActionId, () => void>>;

export function useActionKeys(handlers: ActionHandlers): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const isMac = isMacPlatform();
    function onKeyDown(event: KeyboardEvent): void {
      const action = matchAction(toShellKeyEvent(event), {
        isMac,
        textEntry: isTextEntryTarget(event.target),
        overlayLayerOpen: isOverlayLayerOpen(),
        listFocused: isFocusInRunList()
      });
      if (action === undefined) {
        return;
      }
      const handler = handlersRef.current[action];
      if (handler === undefined) {
        return;
      }
      event.preventDefault();
      handler();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);
}
