/**
 * Window-level keyboard hook for the shell, built on the pure matchers in
 * `shell-keys.ts`. This is the issue-local stand-in for #134's action registry: it
 * maps a resolved shell action id to a handler. `]` (pane toggle) resolves but is a
 * deliberate no-op while the detail pane is disabled, preserving the key contract
 * for #134.
 */
import { useEffect, useRef } from 'react';

import {
  isMacPlatform,
  isOverlayLayerOpen,
  isTextEntryTarget,
  resolveShellKeyAction
} from './shell-keys.js';

export interface ShellKeyHandlers {
  /** Toggle the primary sidebar open/closed (`[`). */
  toggleSidebar(): void;
  /** Toggle settings open/closed (`Cmd+,` / `Ctrl+,`). */
  toggleSettings(): void;
  /** Close the top layer (Escape): hover sidebar first, then settings. */
  closeLayer(): void;
}

export function useShellKeys(handlers: ShellKeyHandlers): void {
  // Keep a stable listener; read the latest handlers through a ref so changing
  // handler identities never re-subscribe.
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const isMac = isMacPlatform();
    function onKeyDown(event: KeyboardEvent): void {
      const action = resolveShellKeyAction(event, {
        isMac,
        textEntry: isTextEntryTarget(event.target),
        overlayLayerOpen: isOverlayLayerOpen()
      });
      switch (action) {
        case 'sidebar-toggle':
          event.preventDefault();
          handlersRef.current.toggleSidebar();
          break;
        case 'settings-toggle':
          event.preventDefault();
          handlersRef.current.toggleSettings();
          break;
        case 'close-layer':
          handlersRef.current.closeLayer();
          break;
        case 'pane-toggle':
        default:
          // `]` is deliberately bound but no-ops until #134 enables the pane.
          break;
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);
}
