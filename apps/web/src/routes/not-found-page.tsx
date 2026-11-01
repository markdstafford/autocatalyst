/**
 * The not-found route.
 *
 * Unknown browser paths must not break the control plane's `index.html` fallback
 * (see #129): the server returns `index.html` for client routes, React Router
 * matches the catch-all, and this page renders with a link back to `/runs`. Both
 * direct loads and in-app navigation render it.
 */
import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';

export function NotFoundPage(): ReactNode {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-3 bg-background px-6 text-text">
      <h1 className="text-xl font-semibold tracking-tight">Page not found</h1>
      <p className="text-subtext">That route does not exist.</p>
      <Link to="/runs" className="text-primary underline underline-offset-2">
        Back to runs
      </Link>
    </main>
  );
}
