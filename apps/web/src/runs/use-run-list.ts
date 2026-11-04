/**
 * The run list state module: one hook that owns initial load, polling, paging,
 * deduplication, project-name joining, and selection reconciliation for the runs
 * collection.
 *
 * Network discipline: a single `busy` guard serializes all list network work, so a
 * poll never overlaps a page load and neither overlaps the initial load. Polling
 * pauses while the page is hidden and runs once immediately when it becomes visible
 * again. A non-401 failure keeps the existing rows and raises `listLost`; a 401 is
 * left to the provider's authorization state (which routes to the connection page)
 * and never raises `listLost`. The list clears `listLost` when it unmounts, because
 * no list source runs off the runs route.
 */
import type { ControlPlaneClient, ListRunsOptions } from '@autocatalyst/sdk';
import { ControlPlaneClientError } from '@autocatalyst/sdk';
import type { Run } from '@autocatalyst/api-contract';
import { useCallback, useEffect, useRef, useState } from 'react';

import { RUN_LIST_PAGE_SIZE, RUN_LIST_POLL_INTERVAL_MS } from './run-list-constants.js';
import {
  buildProjectNameMap,
  computeMissingProjectIds,
  needsProjectRefetch
} from './run-list-projects.js';
import {
  dedupeRuns,
  isSelectionAtEnd,
  moveSelection,
  reconcileSelection,
  resolveInitialSelection,
  type SelectionDirection
} from './run-list-selection.js';
import { mergeRunRows, replaceRunInRows } from './run-row-merge.js';

/** Request filters passed through to every `listRuns` call (e.g. #142's projectId). */
export type RunListRequestArgs = Omit<ListRunsOptions, 'limit' | 'cursor'>;

export type RunListPhase = 'no-token' | 'loading' | 'ready' | 'error';

export interface UseRunListOptions {
  /** The SDK client. */
  readonly client: ControlPlaneClient;
  /** Whether a bearer token is stored. When false, no request or timer runs. */
  readonly connected: boolean;
  /** The `:runId` from the route, if any. */
  readonly routeRunId: string | undefined;
  /** Navigate the address to a run id. `replace` for automatic selection, push for user selection. */
  navigateToRun(runId: string, options: { readonly replace: boolean }): void;
  /** Report the list-driven connection-lost flag to the shell connection context. */
  onListLostChange(lost: boolean): void;
  /** Poll interval override (tests). Defaults to {@link RUN_LIST_POLL_INTERVAL_MS}. */
  readonly pollIntervalMs?: number;
  /** Request filters passed through to `listRuns`. */
  readonly requestArgs?: RunListRequestArgs;
  /** Clock seam (epoch ms) for age timestamps. Defaults to `Date.now`. */
  now?(): number;
}

export interface RunListState {
  readonly phase: RunListPhase;
  readonly rows: readonly Run[];
  readonly selectedRunId: string | undefined;
  readonly projectNames: ReadonlyMap<string, string>;
  /** ISO timestamp the ages are measured against; advances on each poll. */
  readonly nowIso: string;
  readonly hasNextPage: boolean;
  readonly isPaging: boolean;
  select(runId: string): void;
  move(direction: SelectionDirection): void;
  loadNextPage(): void;
  /**
   * Replace a single run's row from an authoritative `getRun` response (the selected-run
   * live-update path). The row is updated in place by id using the same later-`updatedAt`
   * freshness rule as the poll merge, so the pane — which reads the selected run from this
   * state — and the list row change from one source of truth. A run not in the current
   * rows is ignored.
   */
  replaceRun(run: Run): void;
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof ControlPlaneClientError && error.status === 401;
}

export function useRunList(options: UseRunListOptions): RunListState {
  const { client, connected, navigateToRun, onListLostChange, requestArgs } = options;
  const pollIntervalMs = options.pollIntervalMs ?? RUN_LIST_POLL_INTERVAL_MS;
  const nowFn = options.now ?? Date.now;

  const [phase, setPhase] = useState<RunListPhase>(connected ? 'loading' : 'no-token');
  const [rows, setRows] = useState<readonly Run[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(undefined);
  const [projectNames, setProjectNames] = useState<ReadonlyMap<string, string>>(new Map());
  const [nowIso, setNowIso] = useState<string>(() => new Date(nowFn()).toISOString());
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [isPaging, setIsPaging] = useState(false);
  const [started, setStarted] = useState(false);

  // Refs mirror state for use inside async callbacks and the interval without
  // re-subscribing or reading stale closures.
  const rowsRef = useRef<readonly Run[]>(rows);
  rowsRef.current = rows;
  const selectedRef = useRef<string | undefined>(selectedRunId);
  selectedRef.current = selectedRunId;
  const cursorRef = useRef<string | undefined>(nextCursor);
  cursorRef.current = nextCursor;
  const pageCountRef = useRef(0);
  const knownNamesRef = useRef<Map<string, string>>(new Map());
  const missingNamesRef = useRef<Set<string>>(new Set());
  const busyRef = useRef(false);
  const listLostRef = useRef(false);
  const routeRunIdRef = useRef<string | undefined>(options.routeRunId);
  routeRunIdRef.current = options.routeRunId;
  const requestArgsRef = useRef<RunListRequestArgs | undefined>(requestArgs);
  requestArgsRef.current = requestArgs;
  const navigateRef = useRef(navigateToRun);
  navigateRef.current = navigateToRun;
  const listLostChangeRef = useRef(onListLostChange);
  listLostChangeRef.current = onListLostChange;
  const nowFnRef = useRef(nowFn);
  nowFnRef.current = nowFn;

  const setListLost = useCallback((lost: boolean): void => {
    if (listLostRef.current !== lost) {
      listLostRef.current = lost;
      listLostChangeRef.current(lost);
    }
  }, []);

  const applySelection = useCallback(
    (newSelection: string | undefined, intent: 'auto' | 'user'): void => {
      selectedRef.current = newSelection;
      setSelectedRunId(newSelection);
      if (newSelection === undefined || newSelection === routeRunIdRef.current) {
        // Nothing to navigate: no selection, or the address already matches.
        return;
      }
      // A user move pushes a history entry so browser back returns to the prior
      // selection; automatic reconciliation replaces instead.
      navigateRef.current(newSelection, { replace: intent === 'auto' });
    },
    []
  );

  const listPage = useCallback(
    (cursor: string | undefined) =>
      client.listRuns({
        ...(requestArgsRef.current ?? {}),
        limit: RUN_LIST_PAGE_SIZE,
        ...(cursor !== undefined ? { cursor } : {})
      }),
    [client]
  );

  /** Refetch projects when the rows reference a defined, unknown, not-yet-missing id. */
  const refreshProjectNamesIfNeeded = useCallback(
    async (currentRows: readonly Run[]): Promise<void> => {
      if (!needsProjectRefetch(currentRows, knownNamesRef.current, missingNamesRef.current)) {
        return;
      }
      const { projects } = await client.listProjects();
      const map = buildProjectNameMap(projects);
      knownNamesRef.current = map;
      missingNamesRef.current = computeMissingProjectIds(currentRows, map);
      setProjectNames(new Map(map));
    },
    [client]
  );

  /** Read `pages` pages from the top, following nextCursor. Returns the merged rows + last cursor. */
  const readPages = useCallback(
    async (pages: number): Promise<{ runs: Run[]; nextCursor: string | undefined }> => {
      const target = Math.max(pages, 1);
      const collected: Run[] = [];
      let cursor: string | undefined;
      let last: string | undefined;
      for (let i = 0; i < target; i += 1) {
        const page = await listPage(cursor);
        collected.push(...page.runs);
        last = page.nextCursor;
        if (page.nextCursor === undefined) {
          break;
        }
        cursor = page.nextCursor;
      }
      return { runs: dedupeRuns(collected), nextCursor: last };
    },
    [listPage]
  );

  const commitRows = useCallback(
    async (nextRows: Run[], cursor: string | undefined, pageCount: number): Promise<void> => {
      const prevIds = rowsRef.current.map((r) => r.id);
      // Merge the freshly read rows over the current ones by the later-`updatedAt` rule,
      // so a poll that started before a transition refresh cannot revert the row the
      // refresh just advanced through `replaceRun`.
      const merged = mergeRunRows(rowsRef.current, nextRows);
      const nextIds = merged.map((r) => r.id);
      rowsRef.current = merged;
      setRows(merged);
      cursorRef.current = cursor;
      setNextCursor(cursor);
      pageCountRef.current = pageCount;
      setNowIso(new Date(nowFnRef.current()).toISOString());

      const newSelection =
        selectedRef.current === undefined
          ? resolveInitialSelection(nextIds, routeRunIdRef.current)
          : reconcileSelection(prevIds, nextIds, selectedRef.current);
      applySelection(newSelection, 'auto');

      await refreshProjectNamesIfNeeded(merged);
    },
    [applySelection, refreshProjectNamesIfNeeded]
  );

  // Initial load, and re-run if the client (token) changes.
  useEffect(() => {
    if (!connected) {
      setPhase('no-token');
      return;
    }
    let disposed = false;
    setPhase('loading');
    busyRef.current = true;
    void (async () => {
      try {
        const { runs, nextCursor: cursor } = await readPages(1);
        if (disposed) {
          return;
        }
        // Prime the project map before the first paint so known names resolve.
        try {
          const { projects } = await client.listProjects();
          const map = buildProjectNameMap(projects);
          knownNamesRef.current = map;
          missingNamesRef.current = computeMissingProjectIds(runs, map);
          if (!disposed) {
            setProjectNames(new Map(map));
          }
        } catch (projectError) {
          if (isUnauthorized(projectError)) {
            throw projectError;
          }
          // Names fall back to a dash; the list is still usable.
        }
        if (disposed) {
          return;
        }
        await commitRows(runs, cursor, 1);
        setPhase('ready');
        setListLost(false);
      } catch (error) {
        if (disposed || isUnauthorized(error)) {
          return;
        }
        setPhase('error');
        setListLost(true);
      } finally {
        busyRef.current = false;
        if (!disposed) {
          setStarted(true);
        }
      }
    })();
    return () => {
      disposed = true;
      // No list source runs off the runs route, so always drop the list-driven flag
      // on unmount (idempotent for the consumer), regardless of its last value.
      listLostRef.current = false;
      listLostChangeRef.current(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, connected]);

  const poll = useCallback(async (): Promise<void> => {
    if (busyRef.current) {
      return;
    }
    busyRef.current = true;
    try {
      const { runs, nextCursor: cursor } = await readPages(pageCountRef.current);
      await commitRows(runs, cursor, Math.max(pageCountRef.current, 1));
      setPhase('ready');
      setListLost(false);
    } catch (error) {
      if (isUnauthorized(error)) {
        return;
      }
      setListLost(true);
    } finally {
      busyRef.current = false;
    }
  }, [readPages, commitRows, setListLost]);

  // Poll timer + visibility handling. Starts once the initial attempt has settled.
  useEffect(() => {
    if (!connected || !started) {
      return;
    }
    const id = window.setInterval(() => {
      if (document.visibilityState === 'hidden') {
        return;
      }
      void poll();
    }, pollIntervalMs);
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') {
        void poll();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [connected, started, pollIntervalMs, poll]);

  const loadNextPage = useCallback((): void => {
    if (cursorRef.current === undefined || busyRef.current) {
      return;
    }
    busyRef.current = true;
    setIsPaging(true);
    void (async () => {
      try {
        const page = await listPage(cursorRef.current);
        const merged = dedupeRuns([...rowsRef.current, ...page.runs]);
        await commitRows(merged, page.nextCursor, pageCountRef.current + 1);
        setListLost(false);
      } catch (error) {
        if (isUnauthorized(error)) {
          return;
        }
        // Keep rows and the cursor so the next poll or end trigger can retry.
        setListLost(true);
      } finally {
        busyRef.current = false;
        setIsPaging(false);
      }
    })();
  }, [listPage, commitRows, setListLost]);

  // Route sync: browser back/forward (or a direct /runs/:runId) changes selection
  // without pushing a new address.
  useEffect(() => {
    if (phase !== 'ready') {
      return;
    }
    const routeRunId = options.routeRunId;
    const ids = rows.map((r) => r.id);
    if (routeRunId !== undefined && ids.includes(routeRunId)) {
      if (routeRunId !== selectedRef.current) {
        selectedRef.current = routeRunId;
        setSelectedRunId(routeRunId);
      }
    }
  }, [options.routeRunId, phase, rows]);

  const select = useCallback(
    (runId: string): void => {
      applySelection(runId, 'user');
      const ids = rowsRef.current.map((r) => r.id);
      if (isSelectionAtEnd(ids, runId) && cursorRef.current !== undefined) {
        loadNextPage();
      }
    },
    [applySelection, loadNextPage]
  );

  const replaceRun = useCallback((run: Run): void => {
    const next = replaceRunInRows(rowsRef.current, run);
    if (next === rowsRef.current) {
      // The incoming run is not newer (or not present); nothing to update.
      return;
    }
    rowsRef.current = next;
    setRows(next);
  }, []);

  const move = useCallback(
    (direction: SelectionDirection): void => {
      const ids = rowsRef.current.map((r) => r.id);
      const current = selectedRef.current;
      const next = moveSelection(ids, current, direction);
      if (next !== undefined && next !== current) {
        applySelection(next, 'user');
      }
      // Moving down onto (or already sitting on) the last loaded row pages in more,
      // even when the selection itself cannot advance past the end.
      const effective = next ?? current;
      if (direction === 'next' && isSelectionAtEnd(ids, effective) && cursorRef.current !== undefined) {
        loadNextPage();
      }
    },
    [applySelection, loadNextPage]
  );

  return {
    phase,
    rows,
    selectedRunId,
    projectNames,
    nowIso,
    hasNextPage: nextCursor !== undefined,
    isPaging,
    select,
    move,
    loadNextPage,
    replaceRun
  };
}
