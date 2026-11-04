/**
 * The one freshness rule for run rows, shared by the list poll merge and the
 * `replaceRun` live-update path.
 *
 * For a given run id, the row with the later `updatedAt` wins. When two rows carry the
 * same `updatedAt`, the existing row is kept, so an older in-flight poll response that
 * reports the same timestamp cannot revert fields a transition refresh already applied.
 * Pure and React-free so both call sites agree and the rule is unit-tested in isolation.
 */
import type { Run } from '@autocatalyst/api-contract';

/** Epoch ms for an ISO timestamp, or NaN when unparseable. */
function updatedAtMs(run: Run): number {
  return Date.parse(run.updatedAt);
}

/**
 * Whether `incoming` is strictly newer than `existing` by `updatedAt`. Equal timestamps
 * are NOT newer (existing wins). An unparseable existing timestamp yields to any parseable
 * incoming one; an unparseable incoming timestamp never wins.
 */
export function isStrictlyNewer(incoming: Run, existing: Run): boolean {
  const incomingMs = updatedAtMs(incoming);
  const existingMs = updatedAtMs(existing);
  if (Number.isNaN(incomingMs)) {
    return false;
  }
  if (Number.isNaN(existingMs)) {
    return true;
  }
  return incomingMs > existingMs;
}

/**
 * Merge an incoming ordered row list over the existing rows. The result follows the
 * incoming order (the server's authoritative ordering), but for each id keeps whichever
 * row has the later `updatedAt`, so a stale poll cannot overwrite a row already advanced
 * by a transition refresh.
 */
export function mergeRunRows(existing: readonly Run[], incoming: readonly Run[]): Run[] {
  const existingById = new Map<string, Run>();
  for (const run of existing) {
    existingById.set(run.id, run);
  }
  return incoming.map((incomingRun) => {
    const existingRun = existingById.get(incomingRun.id);
    if (existingRun === undefined) {
      return incomingRun;
    }
    return isStrictlyNewer(incomingRun, existingRun) ? incomingRun : existingRun;
  });
}

/**
 * Apply a single authoritative run (from `getRun`) to the rows, in place by id, using
 * the same freshness rule. A run not present in the rows is ignored, since the pane only
 * reflects runs that are in the list.
 */
export function replaceRunInRows(rows: readonly Run[], run: Run): readonly Run[] {
  let changed = false;
  const next = rows.map((existing) => {
    if (existing.id !== run.id) {
      return existing;
    }
    if (isStrictlyNewer(run, existing)) {
      changed = true;
      return run;
    }
    return existing;
  });
  // Return the original reference when nothing changed so React can bail out of the
  // state update.
  return changed ? next : rows;
}
