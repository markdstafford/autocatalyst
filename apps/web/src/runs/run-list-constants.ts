/**
 * Run list tuning constants, exported from one place so consumers and tests never
 * redefine them.
 */

/** Page size for every run list read (first load, paging, and each poll page). */
export const RUN_LIST_PAGE_SIZE = 50;

/**
 * Poll interval for the loaded run pages, in milliseconds.
 *
 * The list is polled rather than driven by a change feed because the control
 * plane exposes no collection change feed: the run event stream carries a single
 * run's events and omits `projectId` and `status`, so it cannot keep the list's
 * row data consistent. Re-reading the loaded pages on an interval is the only way
 * to reflect new runs, status/waiting/title changes, and recomputed ages.
 */
export const RUN_LIST_POLL_INTERVAL_MS = 5000;
