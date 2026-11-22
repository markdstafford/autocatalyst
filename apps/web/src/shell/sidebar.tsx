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
 * Contents switch with the settings frame. Project links live between Runs and
 * Settings. In settings, Connection and Projects sit below the Back button.
 */
import type { Project } from '@autocatalyst/api-contract';
import { ArrowLeft, FolderGit2, ListChecks, Plus, PlugZap, Settings as SettingsIcon } from 'lucide-react';
import { forwardRef, type ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';

import { Button } from '../ui/button.js';
import { Tooltip } from '../ui/tooltip.js';
import { actionTooltipKey } from './action-registry.js';
import { isMacPlatform } from './key-utils.js';
import { CONNECTION_PATH, PROJECTS_PATH, RUNS_PATH, isRunsPath, projectIdFromSearch, projectRunsPath } from './navigation.js';

export type SidebarMode = 'docked' | 'overlay' | 'hidden';

const TITLE_ROW_CLASSES = 'flex h-header-bar shrink-0 items-center gap-2 px-3';
const TITLE_TEXT_CLASSES = 'text-md font-medium text-text';
const LIST_CLASSES = 'flex flex-col gap-0.5 p-2';

const ROW_BASE =
  'flex h-control-base shrink-0 items-center gap-2 rounded-sm px-2 text-sm ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ' +
  'focus-visible:ring-offset-1 focus-visible:ring-offset-mantle';

function rowClass({ isActive }: { isActive: boolean }): string {
  return isActive
    ? `${ROW_BASE} bg-surface text-text`
    : `${ROW_BASE} text-subtext hover:bg-hover hover:text-text`;
}

function PrimaryNav({ projects, onStartRun }: {
  readonly projects: readonly Project[];
  onStartRun?(opener: HTMLElement): void;
}): ReactNode {
  const location = useLocation();
  const runs = isRunsPath(location.pathname);
  const projectId = runs ? projectIdFromSearch(location.search) : undefined;
  const allRunsActive = runs && projectId === undefined;
  return (
    <>
      <div className={TITLE_ROW_CLASSES} data-testid="sidebar-title">
        <span className={TITLE_TEXT_CLASSES}>Autocatalyst</span>
      </div>
      <div className={`${LIST_CLASSES} min-h-0`}>
        <div className="flex items-center gap-1">
          <Link to={RUNS_PATH} className={`${rowClass({ isActive: allRunsActive })} min-w-0 flex-1`} aria-current={allRunsActive ? 'page' : undefined}>
            <ListChecks aria-hidden size={14} />
            <span>Runs</span>
          </Link>
          {onStartRun !== undefined ? (
            <Tooltip label="Start a run">
              <Button variant="secondary" size="control-sm" aria-label="Start a run"
                className="aspect-square border-0 bg-transparent px-0 text-subtext hover:bg-hover hover:text-text"
                onClick={(event) => onStartRun(event.currentTarget)}>
                <Plus size={14} aria-hidden />
              </Button>
            </Tooltip>
          ) : null}
        </div>
        {projects.length > 0 ? (
          <div role="group" aria-label="Projects" className="flex min-h-0 flex-col gap-0.5 overflow-auto">
            <div className="flex items-center gap-2 px-2 py-1 text-xs font-medium text-subtext">
              <FolderGit2 aria-hidden size={14} /> Projects
            </div>
            {projects.map((project) => {
              const active = project.id === projectId;
              return (
                <Link
                  key={project.id}
                  data-project-link
                  to={projectRunsPath(project.id)}
                  aria-current={active ? 'page' : undefined}
                  className={`${rowClass({ isActive: active })} pl-7`}
                >
                  <span className="truncate">{project.displayName}</span>
                </Link>
              );
            })}
          </div>
        ) : null}
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
  checkPending = false,
  canLeaveConnection
}: {
  onCloseSettings(): void;
  readonly checkPending?: boolean;
  canLeaveConnection?(): boolean;
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
        <NavLink
          to={PROJECTS_PATH}
          className={(state) => `${rowClass(state)} aria-disabled:cursor-not-allowed aria-disabled:opacity-60`}
          aria-disabled={checkPending || undefined}
          onClick={(event) => {
            if (!(canLeaveConnection?.() ?? !checkPending)) event.preventDefault();
          }}
        >
          <FolderGit2 aria-hidden size={14} />
          <span>Projects</span>
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
  readonly projects?: readonly Project[];
  canLeaveConnection?(): boolean;
  onCloseSettings(): void;
  onStartRun?(opener: HTMLElement): void;
  /** Whether Connection is checking a token; soft-disables the settings Back button. */
  readonly settingsCheckPending?: boolean;
  onPointerLeave?(event: React.PointerEvent<HTMLElement>): void;
}

export const Sidebar = forwardRef<HTMLElement, SidebarProps>(function Sidebar(
  { mode, settings, projects = [], canLeaveConnection, onCloseSettings, settingsCheckPending = false, onPointerLeave, onStartRun },
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
        <SettingsNav onCloseSettings={onCloseSettings} checkPending={settingsCheckPending}
          {...(canLeaveConnection !== undefined ? { canLeaveConnection } : {})} />
      ) : (
        <PrimaryNav projects={projects} {...(onStartRun !== undefined ? { onStartRun } : {})} />
      )}
    </nav>
  );
});
