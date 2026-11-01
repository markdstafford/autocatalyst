/**
 * Application routing and provider composition.
 *
 * Routing uses `react-router-dom`'s declarative `BrowserRouter`/`Routes`/`Route`/
 * `Navigate` APIs with base `/` (see `apps/web/README.md` for the rationale):
 * normal browser history, redirects, and not-found routing without a framework
 * runtime.
 *
 * A layout route renders the persistent `ShellLayout` (sidebar, header, main,
 * footer); its child routes fill the main area. `/` redirects to `/runs`;
 * `/settings` redirects to `/settings/connection`; the settings frame swaps the
 * sidebar and main area while keeping the footer. Anything unmatched renders the
 * not-found page outside the shell. `AppRoutes` is exported separately so tests can
 * mount it under a `MemoryRouter`.
 */
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';

import { ControlPlaneClientProvider } from './client/client-provider.js';
import { NotFoundPage } from './routes/not-found-page.js';
import { RunsPage } from './routes/runs-page.js';
import { ConnectionPage } from './settings/connection-page.js';
import { ShellLayout } from './shell/shell-layout.js';
import { ThemeProvider } from './theme/theme-provider.js';

export function AppRoutes(): ReactNode {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/runs" replace />} />
      <Route element={<ShellLayout />}>
        <Route path="/runs" element={<RunsPage />} />
        <Route path="/settings" element={<Navigate to="/settings/connection" replace />} />
        <Route path="/settings/connection" element={<ConnectionPage />} />
      </Route>
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}

export function App(): ReactNode {
  return (
    <ThemeProvider>
      <ControlPlaneClientProvider>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </ControlPlaneClientProvider>
    </ThemeProvider>
  );
}
