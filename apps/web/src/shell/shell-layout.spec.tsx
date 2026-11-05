/**
 * Shell layout integration: sidebar default/toggle/persistence through #131
 * preferences (via the theme provider's single writer), settings open/close with
 * `Cmd+,`/`Ctrl+,` and Escape, and the sidebar → header → main → footer tab order.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

function renderAppWith(fetchImpl: typeof globalThis.fetch, path = '/runs'): void {
  render(
    <ThemeProvider>
      <ControlPlaneClientProvider fetch={fetchImpl}>
        <MemoryRouter initialEntries={[path]}>
          <AppRoutes />
        </MemoryRouter>
      </ControlPlaneClientProvider>
    </ThemeProvider>
  );
}

afterEach(() => {
  clearBearerToken();
  vi.restoreAllMocks();
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

describe('settings close guard while Connection is checking', () => {
  interface Gate {
    readonly fetchImpl: typeof globalThis.fetch;
    release(): void;
  }

  function gatedProjectsFetch(): Gate {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl: typeof globalThis.fetch = async (input) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/v1/projects')) {
        await gate;
        return new Response(JSON.stringify({ projects: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      // Health and anything else answer immediately so only the token check is in flight.
      return new Response(JSON.stringify({ status: 'ok', database: { status: 'reachable' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    };
    return {
      fetchImpl,
      release: () => {
        release?.();
      }
    };
  }

  async function startCheck(): Promise<void> {
    await userEvent.type(screen.getByLabelText('Bearer token'), 'tok');
    fireEvent.keyDown(screen.getByLabelText('Bearer token'), { key: 'Enter' });
    expect(await screen.findByText('Checking')).toBeDefined();
  }

  it('refuses Ctrl+, while checking and allows it again after the check settles', async () => {
    const gate = gatedProjectsFetch();
    renderAppWith(gate.fetchImpl, '/settings/connection');
    await startCheck();

    // Toggle-settings is blocked by the shared guard while checking.
    fireEvent.keyDown(document.body, { key: ',', ctrlKey: true });
    expect(screen.getByRole('heading', { level: 1, name: 'Connection' })).toBeDefined();

    await act(async () => {
      gate.release();
    });
    expect(await screen.findByText('Connected')).toBeDefined();

    // After the check settles, the same shortcut closes settings again.
    fireEvent.keyDown(document.body, { key: ',', ctrlKey: true });
    expect(screen.getByRole('heading', { level: 1, name: 'Runs' })).toBeDefined();
  });

  it('refuses Escape (close-layer) while checking and allows it again after the check settles', async () => {
    const gate = gatedProjectsFetch();
    renderAppWith(gate.fetchImpl, '/settings/connection');
    await startCheck();

    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.getByRole('heading', { level: 1, name: 'Connection' })).toBeDefined();

    await act(async () => {
      gate.release();
    });
    expect(await screen.findByText('Connected')).toBeDefined();

    // After success the field is empty, so Escape is an empty-field close-layer again.
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.getByRole('heading', { level: 1, name: 'Runs' })).toBeDefined();
  });

  it('soft-disables Back while checking and leaves after a successful commit', async () => {
    const gate = gatedProjectsFetch();
    renderAppWith(gate.fetchImpl, '/settings/connection');
    await startCheck();

    const back = screen.getByRole('button', { name: 'Back' });
    expect(back.getAttribute('aria-disabled')).toBe('true');
    // Activating Back during the check does not leave settings.
    await userEvent.click(back);
    expect(screen.getByRole('heading', { level: 1, name: 'Connection' })).toBeDefined();

    await act(async () => {
      gate.release();
    });
    expect(await screen.findByText('Connected')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Back' }).getAttribute('aria-disabled')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Runs' })).toBeDefined();
  });

  it('keeps a failed result visible when Back is pressed, then leaves after a good token', async () => {
    let release: (() => void) | undefined;
    let outcome: 'unauthorized' | 'ok' = 'unauthorized';
    const fetchImpl: typeof globalThis.fetch = async (input) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/v1/projects')) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        if (outcome === 'unauthorized') {
          return new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'no' } }), {
            status: 401,
            headers: { 'content-type': 'application/json' }
          });
        }
        return new Response(JSON.stringify({ projects: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      return new Response(JSON.stringify({ status: 'ok', database: { status: 'reachable' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    };
    renderAppWith(fetchImpl, '/settings/connection');

    await userEvent.type(screen.getByLabelText('Bearer token'), 'wrong');
    fireEvent.keyDown(screen.getByLabelText('Bearer token'), { key: 'Enter' });
    expect(await screen.findByText('Checking')).toBeDefined();

    // Back while checking is refused; the operator stays to see the result.
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    await act(async () => {
      release?.();
    });
    expect(await screen.findByText('Failed')).toBeDefined();
    expect(screen.getByRole('heading', { level: 1, name: 'Connection' })).toBeDefined();

    // Correct the token and commit again; success stores it and Back then leaves.
    outcome = 'ok';
    const field = screen.getByLabelText('Bearer token');
    await userEvent.clear(field);
    await userEvent.type(field, 'right');
    fireEvent.keyDown(field, { key: 'Enter' });
    await act(async () => {
      release?.();
    });
    expect(await screen.findByText('Connected')).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Runs' })).toBeDefined();
  });
});

describe('shortcuts overlay', () => {
  it('opens on "?" listing registered actions and closes on Escape', async () => {
    renderApp('/runs');
    expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).toBeNull();

    fireEvent.keyDown(document.body, { key: '?' });
    const dialog = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    // The overlay lists actions from the registry, e.g. the selection actions.
    expect(within(dialog).getByText('Next run')).toBeDefined();
    expect(within(dialog).getByText('Detail pane')).toBeDefined();

    fireEvent.keyDown(document.body, { key: 'Escape' });
    // Closing the overlay must not leave or change the runs route.
    expect(screen.getByRole('heading', { level: 1, name: 'Runs' })).toBeDefined();
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).toBeNull();
    });
  });
});

describe('detail pane toggle off the runs route', () => {
  it('"]" on settings does not write the pane preference', () => {
    renderApp('/settings/connection');
    const before = readPreferences().detailPaneVisible;
    fireEvent.keyDown(document.body, { key: ']' });
    expect(readPreferences().detailPaneVisible).toBe(before);
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
