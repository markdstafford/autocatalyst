/** The shell banner: a title row, followed by the collection strip on run routes. */
import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';

import { Button } from '../ui/button.js';
import { Tooltip } from '../ui/tooltip.js';
import { getAction } from './action-registry.js';
import { headerContentForPath, isArchivedRunsSearch, isRunsPath, RUNS_PATH, type ProjectBreadcrumb } from './navigation.js';

interface HeaderProps {
  readonly viewTitle: string;
  readonly project?: ProjectBreadcrumb | undefined;
  readonly viewSettings?: ReactNode;
  readonly chips?: ReactNode;
  showArchived?(): void;
}

export function Header({ viewTitle, project, viewSettings, chips, showArchived }: HeaderProps): ReactNode {
  const { pathname, search } = useLocation();
  const runs = isRunsPath(pathname);
  const archivedOnly = runs && isArchivedRunsSearch(search);
  const { breadcrumb, title } = archivedOnly
    ? { breadcrumb: 'Runs', title: 'Archived runs' }
    : headerContentForPath(pathname, viewTitle, project);
  const archiveAction = getAction('show-archived-runs');

  return (
    <header className="min-w-0 shrink-0 border-b border-border">
      <div data-testid="header-title" className="flex h-header-bar min-w-0 items-center gap-3 px-3">
        <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
          {breadcrumb !== undefined ? (
            <>
              {archivedOnly
                ? <Link to={RUNS_PATH} className="text-sm text-subtext hover:text-text">Runs</Link>
                : <span className="max-w-[45%] truncate text-sm text-subtext">{breadcrumb}</span>}
              <span className="text-sm text-subtext" aria-hidden>/</span>
            </>
          ) : null}
          <h1 className="truncate text-md font-medium text-text">{title}</h1>
        </div>
        {runs && !archivedOnly && showArchived !== undefined ? (
          <Tooltip label={archiveAction.tooltip ?? archiveAction.name}>
            <Button size="control-sm" variant="secondary" onClick={showArchived}>{archiveAction.name}</Button>
          </Tooltip>
        ) : null}
        {runs && !archivedOnly ? viewSettings : null}
      </div>
      {runs && !archivedOnly ? chips : null}
    </header>
  );
}
