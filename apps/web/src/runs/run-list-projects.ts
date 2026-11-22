/** Project-name join and referenced project ids for run rows. */
import type { Project } from '@autocatalyst/api-contract';

import { CELL_DASH } from './run-fields.js';

/** Build the id→displayName map from a projects list. */
export function buildProjectNameMap(projects: readonly Project[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const project of projects) {
    map.set(project.id, project.displayName);
  }
  return map;
}

/** The project cell text for a run's project id: the name, or a dash when unknown/absent. */
export function projectName(
  projectId: string | undefined,
  known: ReadonlyMap<string, string>
): string {
  if (projectId === undefined) {
    return CELL_DASH;
  }
  return known.get(projectId) ?? CELL_DASH;
}

/** The defined project ids referenced by the rows, deduped. */
export function referencedProjectIds(
  rows: readonly { readonly projectId?: string | undefined }[]
): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.projectId !== undefined) {
      ids.add(row.projectId);
    }
  }
  return [...ids];
}
