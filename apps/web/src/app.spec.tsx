/**
 * Router behavior tests: `/` redirects to `/runs` (the shell with the connect empty
 * state when no token is stored), `/settings` redirects to `/settings/connection`
 * (the settings frame with the Connection page), and unknown paths render the
 * not-found page outside the shell. Routes mount under a `MemoryRouter`.
 */
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';

import { AppRoutes } from './app.js';
import { ControlPlaneClientProvider } from './client/client-provider.js';
import { clearBearerToken } from './auth/token-store.js';
import { ThemeProvider } from './theme/theme-provider.js';

function okHealth(): Response {
  return new Response(JSON.stringify({ status: 'ok', database: { status: 'reachable' } }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

function renderAt(path: string): void {
  render(
    <ThemeProvider>
      <ControlPlaneClientProvider fetch={async () => okHealth()}>
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

describe('AppRoutes', () => {
  it('redirects / to /runs and shows the shell with the connect empty state', () => {
    renderAt('/');
    expect(screen.getByRole('heading', { level: 1, name: 'Runs' })).toBeDefined();
    expect(screen.getByText('Connect to the control plane')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Open connection settings' })).toBeDefined();
  });

  it('marks the Runs sidebar entry as the current page on /runs', () => {
    renderAt('/runs');
    const runs = screen.getByRole('link', { name: 'Runs' });
    expect(runs.getAttribute('aria-current')).toBe('page');
  });

  it('redirects /settings to /settings/connection and shows the Connection page', () => {
    renderAt('/settings');
    // Header shows the breadcrumb + title; the settings page shows its own title.
    expect(screen.getByRole('heading', { level: 1, name: 'Connection' })).toBeDefined();
    expect(screen.getByLabelText('Bearer token')).toBeDefined();
  });

  it('renders the settings sidebar with a close control on the connection route', () => {
    renderAt('/settings/connection');
    expect(screen.getByRole('button', { name: 'Close settings' })).toBeDefined();
    const connection = screen.getByRole('link', { name: 'Connection' });
    expect(connection.getAttribute('aria-current')).toBe('page');
  });

  it('renders the not-found page for an unknown path, with a link back to /runs', () => {
    renderAt('/not-a-route');
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeDefined();
    const link = screen.getByRole('link', { name: 'Back to runs' });
    expect(link.getAttribute('href')).toBe('/runs');
  });
});
