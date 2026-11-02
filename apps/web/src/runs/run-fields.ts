/**
 * Pure per-row display helpers for the run list: the single source for the title
 * fallback, status word/dot, waiting-cell mapping, and age formatting.
 *
 * These are deliberately free of React and the SDK so the rules are unit-tested in
 * isolation and reused by the table cells and tests without duplication.
 */
import type { Run, RunStatus, RunWaitingOn } from '@autocatalyst/api-contract';

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
// Status
// ---------------------------------------------------------------------------

/** Status dot color token class and accessible status name, keyed by status. */
export const STATUS_DOT: Readonly<Record<RunStatus, { readonly colorClass: string; readonly label: string }>> = {
  in_progress: { colorClass: 'bg-primary', label: 'In progress' },
  done: { colorClass: 'bg-green', label: 'Done' },
  failed: { colorClass: 'bg-red', label: 'Failed' },
  canceled: { colorClass: 'bg-overlay', label: 'Canceled' }
};

/** The human status word for the status column; a dash when status is absent. */
export function statusWord(status: RunStatus | undefined): string {
  if (status === undefined) {
    return CELL_DASH;
  }
  return STATUS_DOT[status].label;
}

// ---------------------------------------------------------------------------
// Waiting
// ---------------------------------------------------------------------------

export interface WaitingCell {
  /** Text shown in the waiting column. */
  readonly label: string;
  /** Optional tooltip (used for the "nothing is waiting" case). */
  readonly tooltip?: string;
  /** Whether this is the primary-filled "Waiting on you" signal. */
  readonly primary: boolean;
}

/**
 * The one waiting-label mapping table for an in-progress run. Ended runs never use
 * this table (they always show a dash).
 */
export const WAITING_LABELS: Readonly<Record<RunWaitingOn, WaitingCell>> = {
  human: { label: 'Waiting on you', primary: true },
  ai: { label: 'Working', primary: false },
  system: { label: 'Working', primary: false },
  none: { label: CELL_DASH, tooltip: 'Nothing is waiting on this run.', primary: false }
};

/**
 * The waiting cell for a run. Only in-progress runs read the mapping table; any
 * ended status (or a missing waiting value) shows a dash.
 */
export function waitingCell(run: Run): WaitingCell {
  if (run.status !== 'in_progress' || run.waitingOn === undefined) {
    return { label: CELL_DASH, primary: false };
  }
  return WAITING_LABELS[run.waitingOn];
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
