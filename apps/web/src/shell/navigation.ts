/**
 * Shell routes and the header title/breadcrumb rules.
 *
 * Keep project scopes in the search string, independent of the selected run path.
 */
export const RUNS_PATH = '/runs';
export const SETTINGS_PATH = '/settings';
export const CONNECTION_PATH = '/settings/connection';
export const PROJECTS_PATH = '/settings/projects';
export const NEW_PROJECT_PATH = `${PROJECTS_PATH}/new`;

export function projectPath(id: string): string {
  return `${PROJECTS_PATH}/${encodeURIComponent(id)}`;
}

export function projectIdFromSearch(search: string): string | undefined {
  return new URLSearchParams(search).get('project') ?? undefined;
}

export function projectRunsPath(id: string, path = RUNS_PATH): string {
  return `${path}?${new URLSearchParams({ project: id })}`;
}

/** Whether a pathname is inside the settings frame. */
export function isSettingsPath(pathname: string): boolean {
  return pathname === SETTINGS_PATH || pathname.startsWith(`${SETTINGS_PATH}/`);
}

/**
 * Whether a pathname is the runs destination: the collection (`/runs`) or a
 * selected run (`/runs/:runId`). The detail pane and its footer zone are enabled
 * only on this route.
 */
export function isRunsPath(pathname: string): boolean {
  return pathname === RUNS_PATH || pathname.startsWith(`${RUNS_PATH}/`);
}

/** The address for a selected run, e.g. `/runs/run-123`. */
export function runPath(runId: string): string {
  return `${RUNS_PATH}/${runId}`;
}

export interface HeaderContent {
  /** Breadcrumb shown before the title on deeper views; absent on top-level views. */
  readonly breadcrumb?: string;
  /** The view title. */
  readonly title: string;
}

export interface ProjectBreadcrumb {
  readonly phase: 'loading' | 'ready' | 'error';
  readonly name?: string | undefined;
}

/** Project scope is a breadcrumb, never the name of the view. */
export function headerContentForPath(pathname: string, viewTitle: string, project?: ProjectBreadcrumb): HeaderContent {
  if (isSettingsPath(pathname)) {
    const projects = pathname === PROJECTS_PATH || pathname.startsWith(`${PROJECTS_PATH}/`);
    return { breadcrumb: 'Settings', title: projects ? 'Projects' : 'Connection' };
  }
  if (project === undefined) return { title: viewTitle };
  return {
    title: viewTitle,
    breadcrumb: project.name ?? (project.phase === 'loading' ? 'Loading project…' : 'Project unavailable')
  };
}
