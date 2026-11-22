/**
 * The app shell layout: the persistent structure every destination renders inside.
 *
 * Regions: a sidebar (`navigation`), a header (`banner`), the main area (`main`),
 * and the footer (`contentinfo`). The shell fills the viewport and does not scroll;
 * only the main area's content scrolls. Shell dimensions come from the design-system
 * tokens (`--width-sidebar`, `--height-header-bar`, `--height-footer`,
 * `--width-footer-control`, `--width-hover-zone`), never hard-coded numbers.
 *
 * The sidebar is open by default, persisted through #131 preferences via the theme
 * provider's update hook (one writer, so a sidebar toggle never drops theme fields).
 * When closed it collapses to zero width; a left-edge hover strip reveals it as an
 * overlay that covers the header and footer without moving them. The settings frame
 * swaps the sidebar content and the main area while keeping the footer unchanged.
 *
 * Detail pane: on the runs route the footer's detail-pane toggle and `]` show and hide
 * the side pane, and its shown/hidden state and width ride on the same guarded
 * preferences object. The shell owns that state and hands it to the runs route through
 * the outlet context ({@link RunsOutletContext}); off the runs route the toggle and `]`
 * are inert and write nothing, and the footer's detail-pane zone is zero width.
 *
 * Keyboard: `[` toggles the sidebar, `Cmd+,`/`Ctrl+,` toggles settings from anywhere,
 * Escape closes the top layer (shortcuts overlay, then hover sidebar, then settings),
 * `]` toggles the detail pane on the runs route, and `?` opens the shortcuts overlay.
 * All keys flow through the action registry.
 */
import type { Run } from '@autocatalyst/api-contract';
import { startTransition, useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';

import { hasBearerToken } from '../auth/token-store.js';
import { ProjectDirectoryProvider, useProjectDirectory } from '../projects/project-directory.js';
import { RunDetailFooterProvider, useRunDetailFooter } from '../runs/run-detail-footer.js';
import { StartRunDialog } from '../runs/start-run-dialog.js';
import { clampPaneWidth } from '../theme/preferences.js';
import { useTheme } from '../theme/theme-provider.js';
import { ConnectionStateProvider, useConnectionState } from './connection-state.js';
import { Footer } from './footer.js';
import { Header } from './header.js';
import { CONNECTION_PATH, RUNS_PATH, isRunsPath, isSettingsPath, projectIdFromSearch } from './navigation.js';
import { ShortcutsOverlay } from './shortcuts-overlay.js';
import { Sidebar, type SidebarMode } from './sidebar.js';
import { useShellKeys } from './use-shell-keys.js';

/**
 * State the shell shares with the runs route so the list and the footer agree on the
 * detail pane. Provided via React Router's outlet context.
 */
export interface RunsOutletContext {
  /** Whether the side detail pane is shown. */
  readonly detailPaneVisible: boolean;
  /** Current side-pane width in px. */
  readonly sidePaneWidthPx: number;
  /** Persist a new pane width, clamped to the design-system range and the main area. */
  setPaneWidth(nextWidthPx: number, mainAreaWidthPx?: number): void;
  readonly startRunOpen: boolean;
  openStartRun(opener: HTMLElement): void;
  readonly receiveCreatedRun: { current: ((run: Run) => void) | null };
}

export function ShellLayout(): ReactNode {
  // The shell-level connection state must wrap the layout so `closeSettings`, the
  // sidebar, and the Connection page (an outlet descendant) all read one provider.
  return (
    <ConnectionStateProvider>
      <RunDetailFooterProvider>
        <ProjectDirectoryProvider>
          <ShellLayoutInner />
        </ProjectDirectoryProvider>
      </RunDetailFooterProvider>
    </ConnectionStateProvider>
  );
}

function ShellLayoutInner(): ReactNode {
  const { preferences, updatePreferences } = useTheme();
  const connectionState = useConnectionState();
  const runDetailFooter = useRunDetailFooter();
  const { projects } = useProjectDirectory();
  const sidebarOpen = preferences.sidebarOpen;
  const location = useLocation();
  const navigate = useNavigate();
  const settings = isSettingsPath(location.pathname);
  const paneEnabled = isRunsPath(location.pathname);
  const activeProjectId = paneEnabled ? projectIdFromSearch(location.search) : undefined;
  const projectName = projects.find((project) => project.id === activeProjectId)?.displayName;
  // The pane only renders once a run list exists, i.e. with a stored token. Without
  // one the runs route shows the connect prompt, so the footer's detail-pane zone must
  // stay zero width even though the toggle itself is enabled on the route.
  const paneVisible = paneEnabled && hasBearerToken() && preferences.detailPaneVisible;

  const [hoverOpen, setHoverOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [startOpen, setStartOpen] = useState(false);
  const startRunOpen = paneEnabled && startOpen;
  const opener = useRef<HTMLElement | null>(null);
  const receiveCreatedRun = useRef<((run: Run) => void) | null>(null);
  const focusTarget = useRef<'opener' | 'settings' | 'run'>('opener');
  const main = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    if (!paneEnabled) setStartOpen(false);
  }, [paneEnabled]);

  const openStartRun = (element: HTMLElement): void => {
    opener.current = element;
    focusTarget.current = 'opener';
    setStartOpen(true);
  };

  const sidebarRef = useRef<HTMLElement | null>(null);
  const focusProjects = useRef(false);
  useLayoutEffect(() => {
    if (sidebarOpen && focusProjects.current) {
      focusProjects.current = false;
      const nav = sidebarRef.current;
      (nav?.querySelector<HTMLElement>('[data-project-link][aria-current]') ??
        nav?.querySelector<HTMLElement>('[data-project-link]'))?.focus();
    }
  }, [sidebarOpen]);

  // Remember the route to return to when settings closes. Updated whenever the
  // operator is not in settings.
  const returnRouteRef = useRef<string>(RUNS_PATH);
  if (!settings) {
    returnRouteRef.current = `${location.pathname}${location.search}`;
  }

  const setSidebarOpen = useCallback(
    (open: boolean): void => {
      updatePreferences({ sidebarOpen: open });
      if (open) {
        setHoverOpen(false);
      }
    },
    [updatePreferences]
  );

  const openSettings = useCallback((): void => {
    navigate(CONNECTION_PATH);
  }, [navigate]);

  const closeSettings = useCallback((): void => {
    // While the Connection page is checking a token, keep settings open so the result
    // (`Connected` or `Failed`) is always visible before the operator leaves. This one
    // guard covers Back, the settings toggle shortcut, and empty-field Escape, since
    // they all route here. The ref read is live, so a blur-started check in the same
    // gesture as the close attempt is observed even before a re-render.
    if (connectionState.isSettingsCheckPending()) {
      return;
    }
    navigate(returnRouteRef.current || RUNS_PATH);
  }, [navigate, connectionState]);

  const togglePane = useCallback((): void => {
    // Off the runs route the pane does not exist, so `]` writes nothing.
    if (!paneEnabled) {
      return;
    }
    updatePreferences({ detailPaneVisible: !preferences.detailPaneVisible });
  }, [paneEnabled, preferences.detailPaneVisible, updatePreferences]);

  const setPaneWidth = useCallback(
    (nextWidthPx: number, mainAreaWidthPx?: number): void => {
      updatePreferences({ sidePaneWidthPx: clampPaneWidth(nextWidthPx, mainAreaWidthPx) });
    },
    [updatePreferences]
  );

  useShellKeys({
    toggleSidebar: () => {
      setSidebarOpen(!sidebarOpen);
    },
    toggleSettings: () => {
      if (settings) {
        closeSettings();
      } else {
        openSettings();
      }
    },
    closeLayer: () => {
      if (shortcutsOpen) {
        setShortcutsOpen(false);
      } else if (hoverOpen) {
        setHoverOpen(false);
      } else if (settings) {
        closeSettings();
      }
    },
    // Only bind the pane toggle on the runs route so `]` is a true no-op elsewhere.
    ...(paneEnabled ? { togglePane } : {}),
    openShortcuts: () => {
      setShortcutsOpen(true);
    }
  }, !startRunOpen);

  const sidebarMode: SidebarMode = sidebarOpen ? 'docked' : hoverOpen ? 'overlay' : 'hidden';

  const handleOverlayPointerLeave = useCallback((): void => {
    // Close only if focus is not inside the overlay.
    if (!startRunOpen && sidebarRef.current?.contains(document.activeElement) !== true) {
      setHoverOpen(false);
    }
  }, [startRunOpen]);

  const outletContext: RunsOutletContext = {
    detailPaneVisible: preferences.detailPaneVisible,
    sidePaneWidthPx: preferences.sidePaneWidthPx,
    setPaneWidth,
    startRunOpen,
    openStartRun,
    receiveCreatedRun
  };

  return (
    <>
      <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-text">
        <div className="flex min-h-0 flex-1">
          <Sidebar
            ref={sidebarRef}
            mode={sidebarMode}
            settings={settings}
            projects={projects}
            onCloseSettings={closeSettings}
            {...(paneEnabled ? { onStartRun: openStartRun } : {})}
            settingsCheckPending={connectionState.settingsCheckPending}
            canLeaveConnection={() => !connectionState.isSettingsCheckPending()}
            {...(sidebarMode === 'overlay' ? { onPointerLeave: handleOverlayPointerLeave } : {})}
          />

          <div className="flex min-w-0 flex-1 flex-col">
            <Header projectName={projectName} />
            <main ref={main} tabIndex={-1} className="min-h-0 flex-1 overflow-hidden bg-background focus:outline-none">
              <Outlet context={outletContext} />
            </main>
          </div>
        </div>

        <Footer
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => {
            setSidebarOpen(!sidebarOpen);
          }}
          {...(!settings && sidebarMode === 'hidden' && projects.length > 0 ? {
            onExpandProjects: () => {
              focusProjects.current = true;
              setSidebarOpen(true);
            }
          } : {})}
          paneEnabled={paneEnabled}
          paneVisible={paneVisible}
          paneWidthPx={preferences.sidePaneWidthPx}
          onTogglePane={togglePane}
          detailFooter={paneVisible ? runDetailFooter.content : null}
        />

        {/* Left-edge hover strip: only while the sidebar is closed and not already
            shown as an overlay. Ends at the footer top so the left control stays
            reachable. */}
        {!sidebarOpen && !hoverOpen ? (
          <div
            data-testid="sidebar-hover-zone"
            className="fixed left-0 top-0 z-30 w-hover-zone"
            style={{ height: 'calc(100vh - var(--height-footer))' }}
            onPointerEnter={() => {
              setHoverOpen(true);
            }}
          />
        ) : null}

        <StartRunDialog open={startRunOpen} onClose={() => setStartOpen(false)}
          returnFocus={() => {
            if (focusTarget.current === 'run') {
              return main.current?.querySelector<HTMLElement>('[data-run-id][aria-selected="true"]') ?? main.current ?? false;
            }
            if (focusTarget.current === 'settings') {
              return main.current?.querySelector<HTMLElement>('h2[tabindex="-1"]') ?? main.current ?? false;
            }
            const target = opener.current;
            return target?.isConnected && target.closest('[inert]') === null ? target : main.current ?? false;
          }}
          onNavigate={(path, fromRuns) => {
            focusTarget.current = 'settings';
            opener.current = null;
            startTransition(() => {
              setStartOpen(false);
              setHoverOpen(false);
              navigate(path, fromRuns ? { state: { fromRuns: true } } : undefined);
            });
          }}
          onCreated={(run) => {
            focusTarget.current = 'run';
            opener.current = null;
            startTransition(() => {
              setStartOpen(false);
              setHoverOpen(false);
              updatePreferences({ detailPaneVisible: true });
              receiveCreatedRun.current?.(run);
            });
          }} />
        <ShortcutsOverlay open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      </div>
    </>
  );
}
