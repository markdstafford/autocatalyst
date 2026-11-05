/**
 * The primary sidebar and its settings variant, sharing one `<nav>` element and the
 * `--width-sidebar` token.
 *
 * The same component renders docked (sidebar open), as a hover overlay (sidebar
 * closed, pointer on the left edge), or hidden (sidebar closed). Closed content is
 * removed from the tab order and accessibility tree via `inert`, so a keyboard
 * operator reaches entries only by reopening the sidebar (`[` or the footer toggle)
 * or while the hover overlay is shown.
 *
 * Contents switch with the settings frame: the primary sidebar lists Runs and
 * Settings; the settings sidebar's title row is a Back button followed by the
 * `Settings` label (reading `← Settings`), then the single Connection row.
 */
import { ArrowLeft, ListChecks, PlugZap, Settings as SettingsIcon } from 'lucide-react';
import { forwardRef, type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';

import { Button } from '../ui/button.js';
import { Tooltip } from '../ui/tooltip.js';
import { actionTooltipKey } from './action-registry.js';
import { isMacPlatform } from './key-utils.js';
import { CONNECTION_PATH, RUNS_PATH } from './navigation.js';

export type SidebarMode = 'docked' | 'overlay' | 'hidden';

const TITLE_ROW_CLASSES = 'flex h-header-bar shrink-0 items-center gap-2 px-3';
const TITLE_TEXT_CLASSES = 'text-md font-medium text-text';
const LIST_CLASSES = 'flex flex-col gap-0.5 p-2';

const ROW_BASE =
  'flex h-control-base items-center gap-2 rounded-sm px-2 text-sm ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ' +
  'focus-visible:ring-offset-1 focus-visible:ring-offset-mantle';

function rowClass({ isActive }: { isActive: boolean }): string {
  return isActive
    ? `${ROW_BASE} bg-surface text-text`
    : `${ROW_BASE} text-subtext hover:bg-hover hover:text-text`;
}

function PrimaryNav(): ReactNode {
  return (
    <>
      <div className={TITLE_ROW_CLASSES} data-testid="sidebar-title">
        <span className={TITLE_TEXT_CLASSES}>Autocatalyst</span>
      </div>
      <div className={LIST_CLASSES}>
        <NavLink to={RUNS_PATH} className={rowClass}>
          <ListChecks aria-hidden size={14} />
          <span>Runs</span>
        </NavLink>
        <NavLink to={CONNECTION_PATH} className={rowClass}>
          <SettingsIcon aria-hidden size={14} />
          <span>Settings</span>
        </NavLink>
      </div>
    </>
  );
}

function SettingsNav({
  onCloseSettings,
  checkPending = false
}: {
  onCloseSettings(): void;
  readonly checkPending?: boolean;
}): ReactNode {
  const isMac = isMacPlatform();
  return (
    <>
      <div className={TITLE_ROW_CLASSES} data-testid="sidebar-title">
        <Tooltip label="Back" keyHint={actionTooltipKey('close-layer', isMac)}>
          <Button
            variant="secondary"
            aria-label="Back"
            // While Connection is checking a token, Back is soft-disabled: it stays
            // focusable (no keyboard trap) and looks dimmed, but activation still
            // reaches `onCloseSettings`. The single source of truth is the shared
            // `closeSettings` guard, which refuses to leave while a check is pending;
            // `activateWhenAriaDisabled` keeps the button from short-circuiting that
            // path, so click and keyboard activation both flow through the guard.
            aria-disabled={checkPending || undefined}
            activateWhenAriaDisabled
            onClick={onCloseSettings}
            className="aspect-square px-0"
            size="control-sm"
          >
            <ArrowLeft aria-hidden size={14} />
          </Button>
        </Tooltip>
        <span className={TITLE_TEXT_CLASSES}>Settings</span>
      </div>
      <div className={LIST_CLASSES}>
        <NavLink to={CONNECTION_PATH} className={rowClass}>
          <PlugZap aria-hidden size={14} />
          <span>Connection</span>
        </NavLink>
      </div>
    </>
  );
}

const MODE_CLASSES: Readonly<Record<SidebarMode, string>> = {
  // Docked and hidden animate their width so opening/closing animates the main area.
  docked: 'w-sidebar border-r border-border transition-[width] duration-layout',
  // The overlay is out of flow and snaps to its full width (no width animation) so it
  // is measurable immediately; it carries its own right divider and shadow.
  overlay: 'fixed inset-y-0 left-0 z-40 w-sidebar border-r border-border shadow-popover',
  // Closed collapses to zero width with no border, so the main area starts at the
  // viewport's left edge (no 1 px divider remnant).
  hidden: 'w-0 overflow-hidden transition-[width] duration-layout'
};

const BASE_NAV_CLASSES = 'flex flex-col bg-mantle';

export interface SidebarProps {
  readonly mode: SidebarMode;
  readonly settings: boolean;
  onCloseSettings(): void;
  /** Whether Connection is checking a token; soft-disables the settings Back button. */
  readonly settingsCheckPending?: boolean;
  onPointerLeave?(event: React.PointerEvent<HTMLElement>): void;
}

export const Sidebar = forwardRef<HTMLElement, SidebarProps>(function Sidebar(
  { mode, settings, onCloseSettings, settingsCheckPending = false, onPointerLeave },
  ref
): ReactNode {
  const hidden = mode === 'hidden';
  return (
    <nav
      ref={ref}
      aria-label={settings ? 'Settings' : 'Primary'}
      className={`${BASE_NAV_CLASSES} ${MODE_CLASSES[mode]}`}
      // Closed content leaves the tab order and the accessibility tree.
      {...(hidden ? { inert: true, 'aria-hidden': true } : {})}
      {...(onPointerLeave !== undefined ? { onPointerLeave } : {})}
    >
      {settings ? (
        <SettingsNav onCloseSettings={onCloseSettings} checkPending={settingsCheckPending} />
      ) : (
        <PrimaryNav />
      )}
    </nav>
  );
});
