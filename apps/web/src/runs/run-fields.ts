/**
 * Pure per-row display helpers for the run list: the title fallback and age formatting.
 *
 * These are deliberately free of React and the SDK so the rules are unit-tested in
 * isolation and reused by the table cells and tests without duplication. The derived run
 * state (the status chip vocabulary that once lived here as the status dot/word and the
 * waiting-cell mapping) now lives in `run-state.ts` as the single `runStateChip(run)`
 * mapping used by both the list and the detail pane.
 */
import type { Run } from '@autocatalyst/api-contract';

/** The dash shown for an empty/not-applicable cell. */
export const CELL_DASH = '—';

// ---------------------------------------------------------------------------
// Title
// ---------------------------------------------------------------------------

export interface RowTitle {
  /** Primary row label. */
  readonly title: string;
  /** Secondary identifier shown after the title. */
  readonly number: string;
  /** Whether the row is backed by a tracked issue (vs. falling back to the run id). */
  readonly hasIssue: boolean;
}

/**
 * The row's title and number. With a tracked issue, the issue title and
 * `#<number>` are used; without one, the run id stands in for both and no issue is
 * assumed.
 */
export function rowTitle(run: Run): RowTitle {
  if (run.trackedIssue !== undefined) {
    return {
      title: run.trackedIssue.title,
      number: `#${run.trackedIssue.number}`,
      hasIssue: true
    };
  }
  return { title: run.id, number: run.id, hasIssue: false };
}

// ---------------------------------------------------------------------------
// Age
// ---------------------------------------------------------------------------

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * A short age string from `createdAt` to `nowIso`, using the largest whole unit
 * among minutes, hours, and days. Sub-minute and future ages render as `0m`.
 * Unparseable timestamps render a dash.
 */
export function formatAge(createdAtIso: string, nowIso: string): string {
  const created = Date.parse(createdAtIso);
  const now = Date.parse(nowIso);
  if (Number.isNaN(created) || Number.isNaN(now)) {
    return CELL_DASH;
  }
  const diff = Math.max(0, now - created);
  if (diff < HOUR_MS) {
    return `${Math.floor(diff / MINUTE_MS)}m`;
  }
  if (diff < DAY_MS) {
    return `${Math.floor(diff / HOUR_MS)}h`;
  }
  return `${Math.floor(diff / DAY_MS)}d`;
}
