/**
 * Development-only routes, kept out of production builds.
 *
 * The component gallery lives at {@link DEV_COMPONENTS_PATH}, outside the shell. Its
 * module is pulled in through a `lazy()` dynamic import that sits **behind** an
 * `import.meta.env.DEV` guard: Vite replaces `import.meta.env.DEV` with `false` in a
 * production build, so the `import('./components-gallery.js')` becomes dead code, the
 * gallery chunk is never emitted, and `/dev/components` is never registered. In
 * production the catch-all route then renders the not-found page for that path.
 *
 * {@link devRouteElements} takes `enabled` so a unit test can prove the route is present
 * only when development is on, without depending on the ambient build mode.
 */
import { Suspense, lazy, type ReactNode } from 'react';
import { Route } from 'react-router-dom';

/** The development-only component gallery path. */
export const DEV_COMPONENTS_PATH = '/dev/components';

// The dynamic import is guarded so production tree-shakes the gallery out entirely.
const LazyComponentsGallery = import.meta.env.DEV
  ? lazy(() => import('./components-gallery.js'))
  : null;

/**
 * The dev-only route elements to splice into the app's `<Routes>`. `enabled` defaults to
 * the Vite DEV flag; pass it explicitly in tests. Returns an empty list in production.
 */
export function devRouteElements(enabled: boolean = import.meta.env.DEV): ReactNode[] {
  if (!enabled || LazyComponentsGallery === null) {
    return [];
  }
  return [
    <Route
      key={DEV_COMPONENTS_PATH}
      path={DEV_COMPONENTS_PATH}
      element={
        <Suspense fallback={null}>
          <LazyComponentsGallery />
        </Suspense>
      }
    />
  ];
}
