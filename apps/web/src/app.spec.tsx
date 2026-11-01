/**
 * Router behavior tests: `/` redirects to `/runs` (the foundation page), unknown
 * paths render the not-found page, and the not-found page links back to `/runs`.
 * The routes are mounted under a `MemoryRouter` so each entry point can be tested
 * directly.
 */
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { AppRoutes } from './app.js';
import { ControlPlaneClientProvider } from './client/client-provider.js';
import { ThemeProvider } from './theme/theme-provider.js';

function renderAt(path: string): void {
  render(
    <ThemeProvider>
      <ControlPlaneClientProvider fetch={async () => new Response('{}', { status: 200 })}>
        <MemoryRouter initialEntries={[path]}>
          <AppRoutes />
        </MemoryRouter>
      </ControlPlaneClientProvider>
    </ThemeProvider>
  );
}

describe('AppRoutes', () => {
  it('redirects / to /runs (the foundation page)', () => {
    renderAt('/');
    expect(screen.getByRole('heading', { name: 'Autocatalyst' })).toBeDefined();
  });

  it('renders the foundation page at /runs', () => {
    renderAt('/runs');
    expect(screen.getByRole('heading', { name: 'Autocatalyst' })).toBeDefined();
  });

  it('renders the not-found page for an unknown path, with a link back to /runs', () => {
    renderAt('/not-a-route');
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeDefined();
    const link = screen.getByRole('link', { name: 'Back to runs' });
    expect(link.getAttribute('href')).toBe('/runs');
  });
});
