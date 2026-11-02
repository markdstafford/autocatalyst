/**
 * Pure selection and collection helpers for the run list.
 *
 * Selection is an invariant: whenever rows exist, exactly one row id is selected,
 * and that id always refers to a row present in the current collection. These
 * functions encode the reconciliation rules so the hook and its tests share one
 * source of truth and never let selection drift off the loaded rows.
 */
import type { Run } from '@autocatalyst/api-contract';

/** Remove runs whose id was already seen, preserving first-seen order. */
export function dedupeRuns(runs: readonly Run[]): Run[] {
  const seen = new Set<string>();
  const out: Run[] = [];
  for (const run of runs) {
    if (!seen.has(run.id)) {
      seen.add(run.id);
      out.push(run);
    }
  }
  return out;
}

/**
 * The initial selection for a freshly loaded collection. A route-supplied run id is
 * honored when it is present in the rows; otherwise the first row is selected. An
 * empty collection selects nothing.
 */
export function resolveInitialSelection(
  rowIds: readonly string[],
  routeRunId: string | undefined
): string | undefined {
  if (rowIds.length === 0) {
    return undefined;
  }
  if (routeRunId !== undefined && rowIds.includes(routeRunId)) {
    return routeRunId;
  }
  return rowIds[0];
}

/**
 * Reconcile the selected id after the row collection is replaced (by a poll or a
 * page append).
 *
 * - An empty collection clears the selection.
 * - A still-present selection is kept.
 * - A vanished selection moves to the row now occupying its prior index, or to the
 *   new last row when the removed row had been last.
 * - When the prior position is unknown, the first row is selected.
 */
export function reconcileSelection(
  prevRowIds: readonly string[],
  nextRowIds: readonly string[],
  selectedId: string | undefined
): string | undefined {
  if (nextRowIds.length === 0) {
    return undefined;
  }
  if (selectedId !== undefined && nextRowIds.includes(selectedId)) {
    return selectedId;
  }
  if (selectedId === undefined) {
    return nextRowIds[0];
  }
  const priorIndex = prevRowIds.indexOf(selectedId);
  if (priorIndex === -1) {
    return nextRowIds[0];
  }
  const clamped = Math.min(priorIndex, nextRowIds.length - 1);
  return nextRowIds[clamped];
}

export type SelectionDirection = 'next' | 'previous';

/**
 * The selection after a keyboard move. Movement is bounded at the first and last
 * row: moving past an edge keeps the current selection. Returns the current
 * selection unchanged when there are no rows or nothing is selected.
 */
export function moveSelection(
  rowIds: readonly string[],
  selectedId: string | undefined,
  direction: SelectionDirection
): string | undefined {
  if (rowIds.length === 0 || selectedId === undefined) {
    return selectedId;
  }
  const index = rowIds.indexOf(selectedId);
  if (index === -1) {
    return rowIds[0];
  }
  const target = direction === 'next' ? index + 1 : index - 1;
  if (target < 0 || target >= rowIds.length) {
    return selectedId;
  }
  return rowIds[target];
}

/** Whether the selected row is the last loaded row (the paging trigger position). */
export function isSelectionAtEnd(rowIds: readonly string[], selectedId: string | undefined): boolean {
  if (rowIds.length === 0 || selectedId === undefined) {
    return false;
  }
  return rowIds[rowIds.length - 1] === selectedId;
}
