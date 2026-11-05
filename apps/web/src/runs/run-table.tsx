/**
 * The all-runs table: the single implicit collection view.
 *
 * It renders the loaded run array in server order (newest first) with a sticky
 * column header, one focusable row per run, and the selected row as the list's one
 * roving tab stop (`tabIndex=0`; every other row is `-1`). Exactly one row carries
 * `aria-selected="true"` whenever rows exist. Clicking a row or pressing Enter on a
 * focused row selects it; `j`/`k`/arrow movement is owned by the action registry at
 * the shell scope and flows in through `selectedRunId` changes.
 *
 * Focus discipline matches the spec: focus follows selection only while focus is
 * already inside the list (keyboard navigation), so initial load, polls, and paging
 * never steal focus. The whole list is marked with {@link RUN_LIST_FOCUS_ATTR} so the
 * registry can gate `list-focus` actions on it.
 *
 * Paging has two triggers: the hook advances a page when selection reaches the last
 * loaded row, and an end sentinel here requests the next page when it scrolls into
 * view. Both are no-ops without a next page.
 */
import type { Run } from '@autocatalyst/api-contract';
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';

import { RUN_LIST_FOCUS_ATTR, isFocusInRunList } from '../shell/use-action-keys.js';
import { Chip } from '../ui/chip.js';
import { CELL_DASH, STATUS_DOT, formatAge, rowTitle, statusWord, waitingCell } from './run-fields.js';

export interface RunTableProps {
  readonly rows: readonly Run[];
  readonly selectedRunId: string | undefined;
  readonly projectNames: ReadonlyMap<string, string>;
  /** Timestamp the ages are measured against; advances on each poll. */
  readonly nowIso: string;
  /** Whether another page can be loaded (drives the end sentinel). */
  readonly hasNextPage: boolean;
  /** Whether a next page is currently loading (shows the loading row). */
  readonly isPaging: boolean;
  select(runId: string): void;
  /** Request the next page (end sentinel intersection). */
  loadNextPage(): void;
}

const COLUMNS = ['Title', 'Work kind', 'Status', 'Waiting on', 'Project', 'Age'] as const;

const HEADER_CELL =
  'flex items-center px-3 text-xs font-medium text-subtext';
const BODY_CELL = 'flex items-center px-3 text-base text-subtext';
// The six columns: the title grows; the rest are sized to their content.
const GRID_TEMPLATE = 'minmax(0,1fr) 7rem 7rem 9rem 9rem 4rem';

export function RunTable({
  rows,
  selectedRunId,
  projectNames,
  nowIso,
  hasNextPage,
  isPaging,
  select,
  loadNextPage
}: RunTableProps): ReactNode {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadNextPageRef = useRef(loadNextPage);
  loadNextPageRef.current = loadNextPage;

  // Focus follows selection only while focus already sits in the list, so keyboard
  // navigation keeps focus on the selected row while load/poll/paging never steal it.
  useEffect(() => {
    if (selectedRunId === undefined) {
      return;
    }
    const container = containerRef.current;
    if (container === null || !isFocusInRunList()) {
      return;
    }
    const row = container.querySelector<HTMLElement>(`[data-run-id="${CSS.escape(selectedRunId)}"]`);
    if (row !== null && row !== document.activeElement) {
      row.focus();
    }
  }, [selectedRunId]);

  // End sentinel: request the next page when the bottom of the list scrolls into
  // view. Guarded for environments without IntersectionObserver (jsdom).
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (sentinel === null || !hasNextPage || typeof IntersectionObserver === 'undefined') {
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        loadNextPageRef.current();
      }
    });
    observer.observe(sentinel);
    return () => {
      observer.disconnect();
    };
  }, [hasNextPage, rows.length]);

  function onRowKeyDown(event: KeyboardEvent<HTMLDivElement>, runId: string): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      select(runId);
    }
  }

  return (
    <div
      {...{ [RUN_LIST_FOCUS_ATTR]: '' }}
      ref={containerRef}
      role="grid"
      aria-label="Runs"
      className="flex h-full min-w-0 flex-col overflow-auto bg-background focus:outline-none"
    >
      {/* Sticky column header, same height as the pane bar. */}
      <div
        role="row"
        data-testid="run-table-header"
        className="sticky top-0 z-10 grid h-pane-bar shrink-0 border-b border-border bg-background"
        style={{ gridTemplateColumns: GRID_TEMPLATE }}
      >
        {COLUMNS.map((column) => (
          <div key={column} role="columnheader" className={HEADER_CELL}>
            {column}
          </div>
        ))}
      </div>

      {rows.map((run) => {
        const selected = run.id === selectedRunId;
        const title = rowTitle(run);
        const waiting = waitingCell(run);
        const dot = run.status !== undefined ? STATUS_DOT[run.status] : undefined;
        const projectName =
          run.projectId !== undefined ? projectNames.get(run.projectId) ?? CELL_DASH : CELL_DASH;
        return (
          <div
            key={run.id}
            role="row"
            data-run-id={run.id}
            data-testid={`run-row-${run.id}`}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => {
              select(run.id);
            }}
            onKeyDown={(event) => {
              onRowKeyDown(event, run.id);
            }}
            className={`grid h-row-regular shrink-0 cursor-pointer border-b border-border-faint focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-focus ${
              selected ? 'bg-surface text-text' : 'hover:bg-hover-row'
            }`}
            style={{ gridTemplateColumns: GRID_TEMPLATE }}
          >
            <div role="gridcell" className={`${BODY_CELL} gap-2`}>
              <span
                aria-hidden
                className={`inline-block size-2 shrink-0 rounded-full ${dot?.colorClass ?? 'bg-overlay'}`}
              />
              <span className="truncate text-md text-text">{title.title}</span>
              <span className="shrink-0 text-subtext">{title.number}</span>
            </div>
            <div role="gridcell" className={BODY_CELL}>
              {run.workKind}
            </div>
            <div role="gridcell" className={BODY_CELL}>
              {statusWord(run.status)}
            </div>
            <div role="gridcell" className={BODY_CELL}>
              {waiting.primary ? (
                <Chip tone="primary">{waiting.label}</Chip>
              ) : (
                <span {...(waiting.tooltip !== undefined ? { title: waiting.tooltip } : {})}>
                  {waiting.label}
                </span>
              )}
            </div>
            <div role="gridcell" className={`${BODY_CELL} truncate`}>
              {projectName}
            </div>
            <div role="gridcell" className={`${BODY_CELL} tabular-nums`}>
              {formatAge(run.createdAt, nowIso)}
            </div>
          </div>
        );
      })}

      {isPaging ? (
        <div role="row" data-testid="run-list-loading-row" className="flex h-row-regular shrink-0 items-center px-3 text-base text-subtext">
          Loading more runs…
        </div>
      ) : null}

      {/* End-of-list sentinel for intersection-driven paging. */}
      <div ref={sentinelRef} data-testid="run-list-end-sentinel" aria-hidden className="h-px shrink-0" />
    </div>
  );
}
