/**
 * Application routing and provider composition.
 *
 * Routing uses `react-router-dom`'s declarative `BrowserRouter`/`Routes`/`Route`/
 * `Navigate` APIs with base `/` (see `apps/web/README.md` for the rationale):
 * normal browser history, redirects, and not-found routing without a framework
 * runtime.
 *
 * `/` redirects to `/runs` (the foundation page); anything unmatched renders the
 * not-found page. `AppRoutes` is exported separately so tests can mount it under a
 * `MemoryRouter`.
 */
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';

import { ControlPlaneClientProvider } from './client/client-provider.js';
import { FoundationPage } from './routes/foundation-page.js';
import { NotFoundPage } from './routes/not-found-page.js';
import { ThemeProvider } from './theme/theme-provider.js';

export function AppRoutes(): ReactNode {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/runs" replace />} />
      <Route path="/runs" element={<FoundationPage />} />
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
