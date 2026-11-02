/**
 * The keyboard shortcuts overlay.
 *
 * It opens on `?` (wired through the action registry at the shell scope), lists every
 * registered action with platform-appropriate key caps, and closes on Escape or a
 * backdrop click via the `Dialog` wrapper. The list is built entirely from the
 * registry, so a newly registered action appears here with no extra wiring.
 */
import type { ReactNode } from 'react';

import { Dialog } from '../ui/dialog.js';
import { ACTIONS, actionKeyCaps } from './action-registry.js';
import { isMacPlatform } from './key-utils.js';

export interface ShortcutsOverlayProps {
  readonly open: boolean;
  onOpenChange(open: boolean): void;
}

const CAP_CLASSES =
  'inline-flex min-w-5 items-center justify-center rounded-sm border border-border bg-surface ' +
  'px-1.5 py-0.5 font-mono text-xs text-subtext';

export function ShortcutsOverlay({ open, onOpenChange }: ShortcutsOverlayProps): ReactNode {
  const isMac = isMacPlatform();
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Keyboard shortcuts">
      <ul className="flex flex-col gap-1.5">
        {ACTIONS.map((action) => (
          <li key={action.id} className="flex items-center justify-between gap-6 text-sm text-text">
            <span>{action.name}</span>
            <span className="flex items-center gap-1">
              {actionKeyCaps(action.id, isMac).map((cap, index) => (
                <kbd key={`${action.id}-${index}`} className={CAP_CLASSES}>
                  {cap}
                </kbd>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
