/**
 * Shell routes and the header title/breadcrumb rules.
 *
 * These are the destinations that exist now: Runs and Settings → Connection.
 * Later issues add rows here; the header rule is pure so it is unit-tested for both
 * a top-level route (Runs) and a second-level route (Settings / Connection).
 */
export const RUNS_PATH = '/runs';
export const SETTINGS_PATH = '/settings';
export const CONNECTION_PATH = '/settings/connection';

/** Whether a pathname is inside the settings frame. */
export function isSettingsPath(pathname: string): boolean {
  return pathname === SETTINGS_PATH || pathname.startsWith(`${SETTINGS_PATH}/`);
}

export interface HeaderContent {
  /** Breadcrumb shown before the title on deeper views; absent on top-level views. */
  readonly breadcrumb?: string;
  /** The view title. */
  readonly title: string;
}

/**
 * Header content for a pathname. Top-level views show only a title; deeper views
 * show a breadcrumb plus a title. Only Connection exists under settings today.
 */
export function headerContentForPath(pathname: string): HeaderContent {
  if (isSettingsPath(pathname)) {
    return { breadcrumb: 'Settings', title: 'Connection' };
  }
  return { title: 'Runs' };
}
