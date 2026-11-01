/**
 * The shell header (banner region).
 *
 * Top-level views show only the title (Runs); deeper views show a breadcrumb plus
 * the title (Settings / Connection). The title row is `--height-header-bar` tall and
 * shares its top and bottom edges with the sidebar title row. The `<header>` is not
 * inside a sectioning element, so it exposes the `banner` landmark.
 */
import type { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';

import { headerContentForPath } from './navigation.js';

export function Header(): ReactNode {
  const location = useLocation();
  const { breadcrumb, title } = headerContentForPath(location.pathname);

  return (
    <header className="flex h-header-bar shrink-0 items-center gap-1.5 border-b border-border px-3">
      {breadcrumb !== undefined ? (
        <span className="flex items-center gap-1.5 text-sm text-subtext">
          {breadcrumb}
          <span aria-hidden>/</span>
        </span>
      ) : null}
      <h1 className="truncate text-md font-medium text-text">{title}</h1>
    </header>
  );
}
