/**
 * Dev-route gating: `/dev/components` registers only when development is enabled.
 *
 * The pure `devRouteElements` builder is checked directly for both flag values, and an
 * integration render proves that with dev disabled the path falls through to the
 * catch-all not-found route (the production behavior).
 */
import { isValidElement } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { NotFoundPage } from '../routes/not-found-page.js';
import { DEV_COMPONENTS_PATH, devRouteElements } from './dev-routes.js';

describe('devRouteElements', () => {
  it('registers /dev/components when development is enabled', () => {
    const routes = devRouteElements(true);
    expect(routes).toHaveLength(1);
    const [route] = routes;
    expect(isValidElement(route)).toBe(true);
    expect((route as { props: { path?: string } }).props.path).toBe(DEV_COMPONENTS_PATH);
  });

  it('registers nothing when development is disabled', () => {
    expect(devRouteElements(false)).toEqual([]);
  });
});

describe('dev route in the router', () => {
  it('falls through to not-found for /dev/components when dev is disabled', () => {
    render(
      <MemoryRouter initialEntries={[DEV_COMPONENTS_PATH]}>
        <Routes>
          {devRouteElements(false)}
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </MemoryRouter>
    );
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeDefined();
  });

  it('renders the gallery for /dev/components when dev is enabled', async () => {
    render(
      <MemoryRouter initialEntries={[DEV_COMPONENTS_PATH]}>
        <Routes>
          {devRouteElements(true)}
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getByTestId('component-gallery')).toBeDefined();
    });
  });
});
