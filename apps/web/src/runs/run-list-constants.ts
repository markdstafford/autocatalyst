/**
 * Run list tuning constants, exported from one place so consumers and tests never
 * redefine them.
 */

/** Page size for every run list read (first load, paging, and each poll page). */
export const RUN_LIST_PAGE_SIZE = 50;

// ---------------------------------------------------------------------------
// Grid sizing
// ---------------------------------------------------------------------------

/**
 * The run list grid column widths, in rem. The title column grows to fill the row but
 * never shrinks below its minimum; the other columns are fixed so the chips, project
 * name, and age never collide. Named here so the table and its geometry tests read one
 * source rather than redefining the numbers.
 */
export const RUN_LIST_TITLE_MIN_REM = 10;
export const RUN_LIST_WORK_KIND_REM = 7;
export const RUN_LIST_STATUS_REM = 9;
export const RUN_LIST_PROJECT_REM = 9;
export const RUN_LIST_AGE_REM = 4;

/**
 * The grid template for the five run list columns (Title, Work kind, Status, Project,
 * Age). The title track is `minmax(min, 1fr)` so it grows with the row yet keeps its
 * minimum; every other track is a fixed rem width.
 */
export const RUN_LIST_GRID_TEMPLATE =
  `minmax(${RUN_LIST_TITLE_MIN_REM}rem, 1fr) ${RUN_LIST_WORK_KIND_REM}rem ${RUN_LIST_STATUS_REM}rem ` +
  `${RUN_LIST_PROJECT_REM}rem ${RUN_LIST_AGE_REM}rem`;

/**
 * The grid's minimum total width (title minimum plus the fixed columns), in rem. The list
 * scrolls horizontally rather than letting cells overlap once the viewport is narrower
 * than this; the header row shares the same minimum so it scrolls in lockstep.
 */
export const RUN_LIST_MIN_WIDTH_REM =
  RUN_LIST_TITLE_MIN_REM +
  RUN_LIST_WORK_KIND_REM +
  RUN_LIST_STATUS_REM +
  RUN_LIST_PROJECT_REM +
  RUN_LIST_AGE_REM;

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
