/** The shell banner: a title row, followed by the collection strip on run routes. */
import type { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';

import { headerContentForPath, isRunsPath, type ProjectBreadcrumb } from './navigation.js';

interface HeaderProps {
  readonly viewTitle: string;
  readonly project?: ProjectBreadcrumb | undefined;
  readonly viewSettings?: ReactNode;
  readonly chips?: ReactNode;
}

export function Header({ viewTitle, project, viewSettings, chips }: HeaderProps): ReactNode {
  const { pathname } = useLocation();
  const { breadcrumb, title } = headerContentForPath(pathname, viewTitle, project);
  const runs = isRunsPath(pathname);

  return (
    <header className="min-w-0 shrink-0 border-b border-border">
      <div data-testid="header-title" className="flex h-header-bar min-w-0 items-center gap-3 px-3">
        <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
          {breadcrumb !== undefined ? (
            <>
              <span className="max-w-[45%] truncate text-sm text-subtext">{breadcrumb}</span>
              <span className="text-sm text-subtext" aria-hidden>/</span>
            </>
          ) : null}
          <h1 className="truncate text-md font-medium text-text">{title}</h1>
        </div>
        {runs ? viewSettings : null}
      </div>
      {runs ? chips : null}
    </header>
  );
}
