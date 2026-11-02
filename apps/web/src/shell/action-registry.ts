/**
 * The action registry: the one place every keyboard-driven action is declared, with
 * its name, keys, applies-when rule, and tooltip text. Handlers, tooltips, and the
 * shortcuts overlay all read from here, so no component hard-codes a key.
 *
 * Applies-when rules:
 * - `no-text-entry`: a single-key shortcut, blocked in inputs/editable elements,
 *   while a menu or dialog is open, with any non-shift modifier held, or with AltGr.
 * - `anywhere`: fires everywhere, including inside form fields (the settings toggle).
 * - `layer-open`: Escape; the handler decides which layer to close.
 * - `list-focus`: a single-key shortcut that additionally requires focus inside the
 *   run list (`j`/`k` and the arrows).
 */
import {
  formatChord,
  modifierHeld,
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
  | 'select-previous';

export type AppliesWhen = 'no-text-entry' | 'anywhere' | 'layer-open' | 'list-focus';

export interface ActionDescriptor {
  readonly id: ActionId;
  /** Human-readable action name, shown in the shortcuts overlay. */
  readonly name: string;
  /** Every chord that triggers the action (e.g. `j` and ArrowDown). */
  readonly keys: readonly ShellChord[];
  readonly appliesWhen: AppliesWhen;
}

/**
 * The registry, in overlay display order. Shell actions first, then selection. The
 * tooltip text for a control is composed from `name` + the first chord via
 * {@link actionTooltipKey}; components never pass their own key strings.
 */
export const ACTIONS: readonly ActionDescriptor[] = [
  { id: 'sidebar-toggle', name: 'Sidebar', keys: [{ key: '[' }], appliesWhen: 'no-text-entry' },
  { id: 'pane-toggle', name: 'Detail pane', keys: [{ key: ']' }], appliesWhen: 'no-text-entry' },
  { id: 'settings-toggle', name: 'Settings', keys: [{ key: ',', mod: 'mod' }], appliesWhen: 'anywhere' },
  { id: 'open-shortcuts', name: 'Keyboard shortcuts', keys: [{ key: '?' }], appliesWhen: 'no-text-entry' },
  { id: 'close-layer', name: 'Close', keys: [{ key: 'Escape' }], appliesWhen: 'layer-open' },
  { id: 'select-next', name: 'Next run', keys: [{ key: 'j' }, { key: 'ArrowDown' }], appliesWhen: 'list-focus' },
  { id: 'select-previous', name: 'Previous run', keys: [{ key: 'k' }, { key: 'ArrowUp' }], appliesWhen: 'list-focus' }
];

/** Look up an action by id. Throws on an unknown id (a programming error). */
export function getAction(id: ActionId): ActionDescriptor {
  const action = ACTIONS.find((entry) => entry.id === id);
  if (action === undefined) {
    throw new Error(`Unknown action id: ${id}`);
  }
  return action;
}

/** The tooltip key hint for an action (its first chord), platform-aware. */
export function actionTooltipKey(id: ActionId, isMac: boolean): string {
  const [first] = getAction(id).keys;
  return first === undefined ? '' : formatChord(first, isMac);
}

/** All key caps for an action, for the shortcuts overlay (platform-aware). */
export function actionKeyCaps(id: ActionId, isMac: boolean): string[] {
  return getAction(id).keys.map((chord) => formatChord(chord, isMac));
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

function matchesSettings(event: ShellKeyEvent, isMac: boolean): boolean {
  return event.key === ',' && (isMac ? event.metaKey : event.ctrlKey) && !event.altKey;
}

function matchesSingleKey(event: ShellKeyEvent, keys: readonly ShellChord[]): boolean {
  return keys.some((chord) => chord.mod === undefined && chord.key === event.key);
}

/**
 * Resolve which action a keyboard event triggers, or `undefined`. Pure and fully
 * testable; the hook maps the returned id to a handler.
 */
export function matchAction(event: ShellKeyEvent, ctx: ActionContext): ActionId | undefined {
  // Settings toggle works everywhere, including inside form fields.
  if (matchesSettings(event, ctx.isMac)) {
    return 'settings-toggle';
  }
  // Escape is always available; the handler decides which layer to close.
  if (event.key === 'Escape') {
    return 'close-layer';
  }
  // Remaining actions are single-key: blocked in text entry, open overlays, or with
  // a non-shift modifier held.
  if (ctx.textEntry || ctx.overlayLayerOpen || modifierHeld(event)) {
    return undefined;
  }
  for (const action of ACTIONS) {
    if (action.appliesWhen === 'anywhere' || action.appliesWhen === 'layer-open') {
      continue;
    }
    if (action.appliesWhen === 'list-focus' && !ctx.listFocused) {
      continue;
    }
    if (matchesSingleKey(event, action.keys)) {
      return action.id;
    }
  }
  return undefined;
}
