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
 * Keyboard: `[` toggles the sidebar, `Cmd+,`/`Ctrl+,` toggles settings from
 * anywhere, Escape closes the hover sidebar first and then settings, and `]` is bound
 * but no-ops until #134 enables the detail pane.
 */
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';

import { useTheme } from '../theme/theme-provider.js';
import { Footer } from './footer.js';
import { Header } from './header.js';
import { CONNECTION_PATH, RUNS_PATH, isSettingsPath } from './navigation.js';
import { Sidebar, type SidebarMode } from './sidebar.js';
import { useShellKeys } from './use-shell-keys.js';

export function ShellLayout(): ReactNode {
  const { preferences, updatePreferences } = useTheme();
  const sidebarOpen = preferences.sidebarOpen;
  const location = useLocation();
  const navigate = useNavigate();
  const settings = isSettingsPath(location.pathname);

  const [hoverOpen, setHoverOpen] = useState(false);
  const sidebarRef = useRef<HTMLElement | null>(null);

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
    navigate(returnRouteRef.current || RUNS_PATH);
  }, [navigate]);

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
      if (hoverOpen) {
        setHoverOpen(false);
      } else if (settings) {
        closeSettings();
      }
    }
  });

  const sidebarMode: SidebarMode = sidebarOpen ? 'docked' : hoverOpen ? 'overlay' : 'hidden';

  const handleOverlayPointerLeave = useCallback((): void => {
    // Close only if focus is not inside the overlay.
    if (sidebarRef.current?.contains(document.activeElement) !== true) {
      setHoverOpen(false);
    }
  }, []);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-text">
      <div className="flex min-h-0 flex-1">
        <Sidebar
          ref={sidebarRef}
          mode={sidebarMode}
          settings={settings}
          onCloseSettings={closeSettings}
          {...(sidebarMode === 'overlay' ? { onPointerLeave: handleOverlayPointerLeave } : {})}
        />

        <div className="flex min-w-0 flex-1 flex-col">
          <Header />
          <main className="min-h-0 flex-1 overflow-hidden bg-background">
            <Outlet />
          </main>
        </div>
      </div>

      <Footer
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => {
          setSidebarOpen(!sidebarOpen);
        }}
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
    </div>
  );
}
