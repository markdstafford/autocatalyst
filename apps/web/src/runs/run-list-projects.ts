/**
 * Pure project-name join rules for the run list.
 *
 * The list fetches `listProjects` once on load and then refetches only when a poll
 * or page introduces a *defined* `projectId` that is neither already known nor
 * already looked up since the last fetch. A "missing" set records ids still absent
 * after a fetch so an unresolved id does not trigger a refetch on every poll; it is
 * rebuilt after each successful fetch so a genuinely new id can trigger one future
 * refetch. Rows with an undefined or unknown `projectId` render a dash.
 */
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
  rows: readonly { readonly projectId?: string }[]
): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.projectId !== undefined) {
      ids.add(row.projectId);
    }
  }
  return [...ids];
}

/**
 * Whether a project refetch is warranted: some row references a defined id that is
 * neither known nor already recorded as missing since the last fetch.
 */
export function needsProjectRefetch(
  rows: readonly { readonly projectId?: string }[],
  known: ReadonlyMap<string, string>,
  missing: ReadonlySet<string>
): boolean {
  return referencedProjectIds(rows).some((id) => !known.has(id) && !missing.has(id));
}

/** The set of referenced ids still absent from `known` (recomputed after a fetch). */
export function computeMissingProjectIds(
  rows: readonly { readonly projectId?: string }[],
  known: ReadonlyMap<string, string>
): Set<string> {
  const missing = new Set<string>();
  for (const id of referencedProjectIds(rows)) {
    if (!known.has(id)) {
      missing.add(id);
    }
  }
  return missing;
}
