/**
 * Shell layout integration: sidebar default/toggle/persistence through #131
 * preferences (via the theme provider's single writer), settings open/close with
 * `Cmd+,`/`Ctrl+,` and Escape, and the sidebar → header → main → footer tab order.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';

import { AppRoutes } from '../app.js';
import { clearBearerToken } from '../auth/token-store.js';
import { ControlPlaneClientProvider } from '../client/client-provider.js';
import { readPreferences } from '../theme/preferences.js';
import { ThemeProvider, useTheme } from '../theme/theme-provider.js';

const pendingFetch: typeof globalThis.fetch = () => new Promise(() => {});

function renderApp(path = '/runs'): void {
  render(
    <ThemeProvider>
      <ControlPlaneClientProvider fetch={pendingFetch}>
        <MemoryRouter initialEntries={[path]}>
          <AppRoutes />
        </MemoryRouter>
      </ControlPlaneClientProvider>
    </ThemeProvider>
  );
}

afterEach(() => {
  clearBearerToken();
});

describe('sidebar state', () => {
  it('is open by default', () => {
    renderApp('/runs');
    expect(screen.getByRole('link', { name: 'Runs' })).toBeDefined();
  });

  it('toggles closed/open from the footer control and persists the preference', async () => {
    renderApp('/runs');
    expect(readPreferences().sidebarOpen).toBe(true);

    await userEvent.click(screen.getByRole('button', { name: 'Toggle sidebar' }));
    // Closed content leaves the accessibility tree.
    expect(screen.queryByRole('link', { name: 'Runs' })).toBeNull();
    expect(readPreferences().sidebarOpen).toBe(false);

    await userEvent.click(screen.getByRole('button', { name: 'Toggle sidebar' }));
    expect(screen.getByRole('link', { name: 'Runs' })).toBeDefined();
    expect(readPreferences().sidebarOpen).toBe(true);
  });

  it('toggles with "[" when guards allow it', () => {
    renderApp('/runs');
    fireEvent.keyDown(document.body, { key: '[' });
    expect(screen.queryByRole('link', { name: 'Runs' })).toBeNull();
    expect(readPreferences().sidebarOpen).toBe(false);
  });
});

describe('preference writes preserve each other', () => {
  function Harness(): ReactNode {
    const { preferences, setDarkTheme, updatePreferences } = useTheme();
    return (
      <div>
        <span data-testid="dark">{preferences.darkTheme}</span>
        <span data-testid="sidebar">{String(preferences.sidebarOpen)}</span>
        <button type="button" onClick={() => setDarkTheme('dracula')}>
          set-dark
        </button>
        <button
          type="button"
          onClick={() => updatePreferences({ sidebarOpen: !preferences.sidebarOpen })}
        >
          toggle-sidebar
        </button>
      </div>
    );
  }

  it('a theme change preserves sidebarOpen and a sidebar toggle preserves the theme', async () => {
    render(
      <ThemeProvider>
        <Harness />
      </ThemeProvider>
    );
    await userEvent.click(screen.getByRole('button', { name: 'set-dark' }));
    expect(screen.getByTestId('dark').textContent).toBe('dracula');
    expect(screen.getByTestId('sidebar').textContent).toBe('true');

    await userEvent.click(screen.getByRole('button', { name: 'toggle-sidebar' }));
    expect(screen.getByTestId('sidebar').textContent).toBe('false');
    expect(screen.getByTestId('dark').textContent).toBe('dracula');
    expect(readPreferences().darkTheme).toBe('dracula');
    expect(readPreferences().sidebarOpen).toBe(false);
  });
});

describe('settings frame shortcuts', () => {
  it('opens and closes settings with Ctrl+, and returns to the prior route', () => {
    renderApp('/runs');
    fireEvent.keyDown(document.body, { key: ',', ctrlKey: true });
    expect(screen.getByRole('heading', { level: 1, name: 'Connection' })).toBeDefined();

    fireEvent.keyDown(document.body, { key: ',', ctrlKey: true });
    expect(screen.getByRole('heading', { level: 1, name: 'Runs' })).toBeDefined();
  });

  it('closes settings on Escape', () => {
    renderApp('/settings/connection');
    expect(screen.getByRole('heading', { level: 1, name: 'Connection' })).toBeDefined();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.getByRole('heading', { level: 1, name: 'Runs' })).toBeDefined();
  });

  it('Escape closes the hover sidebar before closing settings', () => {
    renderApp('/settings/connection');
    // Close the docked sidebar so the left-edge hover strip appears.
    fireEvent.keyDown(document.body, { key: '[' });
    fireEvent.pointerEnter(screen.getByTestId('sidebar-hover-zone'));
    // Overlay is shown: the settings nav is live (not inert).
    expect(document.querySelector('nav[aria-label="Settings"]')?.hasAttribute('inert')).toBe(false);

    // First Escape closes only the hover overlay; still in settings.
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.getByRole('heading', { level: 1, name: 'Connection' })).toBeDefined();
    expect(document.querySelector('nav[aria-label="Settings"]')?.hasAttribute('inert')).toBe(true);

    // Second Escape closes settings.
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.getByRole('heading', { level: 1, name: 'Runs' })).toBeDefined();
  });
});

describe('tab order', () => {
  it('runs sidebar, then header, then main, then footer', () => {
    renderApp('/runs');
    const runsLink = screen.getByRole('link', { name: 'Runs' });
    const mainButton = screen.getByRole('button', { name: 'Open connection settings' });
    const footerToggle = screen.getByRole('button', { name: 'Toggle sidebar' });

    const FOLLOWING = Node.DOCUMENT_POSITION_FOLLOWING;
    expect(runsLink.compareDocumentPosition(mainButton) & FOLLOWING).toBeTruthy();
    expect(mainButton.compareDocumentPosition(footerToggle) & FOLLOWING).toBeTruthy();
  });
});
