/**
 * Legacy shell-key adapter.
 *
 * #134 moved the single source of truth for shortcuts to `action-registry.ts`. This
 * module no longer declares any keys: it derives the four shell bindings and the
 * tooltip/matcher helpers from the registry so existing #132 consumers and tests
 * keep working unchanged. New code should read the registry directly.
 */
import {
  ACTIONS,
  matchAction,
  type ActionContext,
  type AppliesWhen
} from './action-registry.js';
import {
  formatChord,
  isMacPlatform,
  isOverlayLayerOpen,
  isTextEntryTarget,
  type ShellChord,
  type ShellKeyEvent
} from './key-utils.js';

export { formatChord, isMacPlatform, isOverlayLayerOpen, isTextEntryTarget };
export type { ShellChord, ShellKeyEvent };

/** The shell actions this adapter exposes (the #132 set). */
export type ShellKeyId = 'sidebar-toggle' | 'settings-toggle' | 'close-layer' | 'pane-toggle';
export type ShellKeyScope = 'no-text-entry' | 'anywhere' | 'layer-open';

const SHELL_KEY_IDS: readonly ShellKeyId[] = ['sidebar-toggle', 'settings-toggle', 'close-layer', 'pane-toggle'];

export interface ShellKeyBinding {
  readonly id: ShellKeyId;
  readonly label: string;
  readonly keys: readonly ShellChord[];
  readonly appliesWhen: ShellKeyScope;
}

function isShellKeyId(id: string): id is ShellKeyId {
  return (SHELL_KEY_IDS as readonly string[]).includes(id);
}

/**
 * The four shell bindings, derived from the registry in the #132 shape. Each registry
 * alternate is now a {@link Binding} (a chord list); the shell actions are all single-chord
 * combos, so the first chord of each binding is the #132 chord.
 */
export const SHELL_KEYS: readonly ShellKeyBinding[] = ACTIONS.filter((action) =>
  isShellKeyId(action.id)
).map((action) => ({
  id: action.id as ShellKeyId,
  label: action.name,
  keys: action.keys.map((binding) => binding[0]),
  appliesWhen: action.appliesWhen as Exclude<AppliesWhen, 'list-focus'> as ShellKeyScope
}));

/** Look up a shell binding by id. Throws if the id is unknown. */
export function getShellKey(id: ShellKeyId): ShellKeyBinding {
  const binding = SHELL_KEYS.find((entry) => entry.id === id);
  if (binding === undefined) {
    throw new Error(`Unknown shell key id: ${id}`);
  }
  return binding;
}

/** The tooltip/README key hint for a binding (its first chord). */
export function keyHintFor(id: ShellKeyId, isMac: boolean): string {
  const [first] = getShellKey(id).keys;
  return first === undefined ? '' : formatChord(first, isMac);
}

export interface ShellKeyContext {
  readonly isMac: boolean;
  readonly textEntry: boolean;
  readonly overlayLayerOpen: boolean;
}

/**
 * Resolve which shell action a keyboard event triggers, or `undefined`. Delegates to
 * the registry matcher (with no run-list focus, so selection keys never resolve here)
 * and returns only the four shell ids.
 */
export function resolveShellKeyAction(event: ShellKeyEvent, ctx: ShellKeyContext): ShellKeyId | undefined {
  const fullContext: ActionContext = { ...ctx, listFocused: false };
  const action = matchAction(event, fullContext);
  return action !== undefined && isShellKeyId(action) ? action : undefined;
}
