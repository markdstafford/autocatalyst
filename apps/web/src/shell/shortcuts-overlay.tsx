/**
 * The keyboard shortcuts overlay.
 *
 * It opens on `?` (wired through the action registry at the shell scope), lists every
 * registered action with its bindings, and closes on Escape or a backdrop click via the
 * `Dialog` wrapper. Bindings render through the shared `ShortcutList` component (with no
 * `limit`, so every alternate shows), separating alternates with "or" and sequence steps
 * with "then". The list is built entirely from the registry, so a newly registered action
 * appears here with no extra wiring.
 */
import type { ReactNode } from 'react';

import { Dialog } from '../ui/dialog.js';
import { ShortcutList, type ShortcutPlatform } from '../ui/shortcut.js';
import { ACTIONS } from './action-registry.js';
import { isMacPlatform } from './key-utils.js';

export interface ShortcutsOverlayProps {
  readonly open: boolean;
  onOpenChange(open: boolean): void;
}

export function ShortcutsOverlay({ open, onOpenChange }: ShortcutsOverlayProps): ReactNode {
  const platform: ShortcutPlatform = isMacPlatform() ? 'mac' : 'other';
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Keyboard shortcuts">
      <ul className="flex flex-col gap-1.5">
        {ACTIONS.map((action) => (
          <li key={action.id} className="flex items-center justify-between gap-6 text-sm text-text">
            <span>{action.name}</span>
            <ShortcutList bindings={action.keys} platform={platform} />
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
