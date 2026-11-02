/**
 * Shell keyboard hook, now backed by the action registry via {@link useActionKeys}.
 *
 * It owns the shell-scope actions: the sidebar toggle (`[`), settings toggle
 * (`Cmd+,`/`Ctrl+,`), Escape layer close, the detail-pane toggle (`]`), and opening
 * the shortcuts overlay (`?`). The pane and shortcuts handlers are optional so a
 * route without a detail pane (or before the overlay exists) can omit them.
 */
import { useActionKeys, type ActionHandlers } from './use-action-keys.js';

export interface ShellKeyHandlers {
  /** Toggle the primary sidebar open/closed (`[`). */
  toggleSidebar(): void;
  /** Toggle settings open/closed (`Cmd+,` / `Ctrl+,`). */
  toggleSettings(): void;
  /** Close the top layer (Escape): hover sidebar first, then settings. */
  closeLayer(): void;
  /** Toggle the detail pane (`]`). Optional: omitted off the runs route. */
  togglePane?(): void;
  /** Open the shortcuts overlay (`?`). Optional. */
  openShortcuts?(): void;
}

export function useShellKeys(handlers: ShellKeyHandlers): void {
  const map: ActionHandlers = {
    'sidebar-toggle': handlers.toggleSidebar,
    'settings-toggle': handlers.toggleSettings,
    'close-layer': handlers.closeLayer,
    ...(handlers.togglePane !== undefined ? { 'pane-toggle': handlers.togglePane } : {}),
    ...(handlers.openShortcuts !== undefined ? { 'open-shortcuts': handlers.openShortcuts } : {})
  };
  useActionKeys(map);
}
