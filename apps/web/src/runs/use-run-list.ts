/**
 * Run collection reads, polling, paging and selection. Each client/filter scope
 * has its own rows, cursor and in-flight guard; obsolete reads cannot commit or
 * navigate. Project names are joined by the caller from the shared directory.
 */
import { ControlPlaneClientError, type ControlPlaneClient } from '@autocatalyst/sdk';
import type { Run } from '@autocatalyst/api-contract';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { RUN_LIST_PAGE_SIZE, RUN_LIST_POLL_INTERVAL_MS } from './run-list-constants.js';
import { dedupeRuns, isSelectionAtEnd, moveSelection, reconcileSelection, resolveInitialSelection, type SelectionDirection } from './run-list-selection.js';
import { mergeRunRows, replaceRunInRows } from './run-row-merge.js';
import { buildRunViewRequest, projectRunViewRows, type RunViewRequest } from './run-view-list.js';
import type { RunView } from './run-views.js';

export type RunListPhase = 'no-token' | 'loading' | 'ready' | 'error';

export interface UseRunListOptions {
  readonly client: Pick<ControlPlaneClient, 'listRuns'>;
  readonly connected: boolean;
  readonly routeRunId: string | undefined;
  /** Replace for automatic selection, push for user selection. */
  navigateToRun(runId: string | undefined, options: { readonly replace: boolean }): void;
  onListLostChange(lost: boolean): void;
  readonly pollIntervalMs?: number;
  readonly activeView: RunView;
  readonly projectId?: string | undefined;
  onUnauthorized?(): void;
  /** Server row from a create response, supplied only on its destination address. */
  readonly createdRun?: Run;
  now?(): number;
}

interface View {
  readonly phase: RunListPhase;
  readonly rows: readonly Run[];
  readonly selectedRunId: string | undefined;
  readonly nextCursor: string | undefined;
  readonly nowIso: string;
  readonly isPaging: boolean;
  readonly started: boolean;
}

interface Scope {
  readonly initial: View;
  readonly exactProjectId: string | undefined;
  readonly listPage?: (cursor?: string) => ReturnType<ControlPlaneClient['listRuns']>;
  view: View;
  rawRows: readonly Run[];
  switched: boolean;
  generation: number;
  active: boolean;
  busy: boolean;
  listLost: boolean;
  pageCount: number;
  awaitingListRunId?: string;
  suspended: boolean;
}

export interface RunListState extends Omit<View, 'started' | 'nextCursor'> {
  readonly hasNextPage: boolean;
  select(runId: string): void;
  move(direction: SelectionDirection): void;
  loadNextPage(): void;
  /** Refresh a present row without allowing a later, stale poll to revert it. */
  replaceRun(run: Run): void;
  /** Retire source reads synchronously before navigation to the created run. */
  prepareCreatedRun(): void;
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof ControlPlaneClientError && error.status === 401;
}

export function useRunList(options: UseRunListOptions): RunListState {
  const { client, connected, activeView, projectId } = options;
  const activeViewId = activeView.id;
  const pollIntervalMs = options.pollIntervalMs ?? RUN_LIST_POLL_INTERVAL_MS;
  const latest = useRef(options);
  latest.current = options;
  // A value key avoids a reset when the route recreates equivalent filters.
  const request = useMemo(() => buildRunViewRequest(activeView, projectId), [activeView, projectId]);
  const filter = JSON.stringify(request);
  const scope = useMemo<Scope>(() => {
    const args = JSON.parse(filter) as RunViewRequest | null;
    const arrival = connected && args !== null ? latest.current.createdRun : undefined;
    const rawRows = arrival === undefined ? [] : [arrival];
    const rows = projectRunViewRows(latest.current.activeView, rawRows);
    const initial: View = {
      phase: !connected ? 'no-token' : arrival !== undefined || args === null ? 'ready' : 'loading',
      rows,
      selectedRunId: rows[0]?.id,
      nextCursor: undefined,
      nowIso: new Date((latest.current.now ?? Date.now)()).toISOString(),
      isPaging: false,
      started: false
    };
    return {
      initial,
      view: initial,
      rawRows,
      switched: false,
      exactProjectId: typeof args?.projectId === 'string' ? args.projectId : undefined,
      ...(args === null ? {} : {
        listPage: (cursor?: string) => client.listRuns({
          ...args,
          limit: RUN_LIST_PAGE_SIZE,
          ...(cursor !== undefined ? { cursor } : {})
        })
      }),
      generation: 0,
      active: false,
      busy: false,
      listLost: false,
      pageCount: 0,
      suspended: false
    };
  }, [client, connected, filter]);

  const [snapshot, setSnapshot] = useState(() => ({ scope, view: scope.initial }));
  const view = snapshot.scope === scope ? snapshot.view : scope.initial;
  const commit = useCallback((patch: Partial<View>): void => {
    scope.view = { ...scope.view, ...patch };
    setSnapshot({ scope, view: scope.view });
  }, [scope]);

  const setListLost = useCallback((lost: boolean): void => {
    if (lost === scope.listLost) return;
    scope.listLost = lost;
    latest.current.onListLostChange(lost);
  }, [scope]);

  const navigateSelection = useCallback((id: string | undefined, replace: boolean): void => {
    if (id !== latest.current.routeRunId) {
      latest.current.navigateToRun(id, { replace });
    }
  }, []);

  const commitRows = useCallback((incoming: Run[], nextCursor: string | undefined, pageCount: number): void => {
    const newId = scope.awaitingListRunId;
    if (newId !== undefined) {
      if (incoming.some((run) => run.id === newId)) delete scope.awaitingListRunId;
      else {
        const created = scope.rawRows.find((run) => run.id === newId);
        if (created !== undefined) incoming = [created, ...incoming];
      }
    }
    scope.rawRows = mergeRunRows(scope.rawRows, incoming);
    const rows = projectRunViewRows(latest.current.activeView, scope.rawRows);
    const ids = rows.map((row) => row.id);
    const switched = scope.switched;
    scope.switched = false;
    const priorSelection = scope.view.selectedRunId;
    const selectedRunId = switched || priorSelection === undefined
      ? resolveInitialSelection(ids, latest.current.routeRunId ?? priorSelection)
      : reconcileSelection(scope.view.rows.map((row) => row.id), ids, priorSelection);
    scope.pageCount = pageCount;
    commit({ rows, nextCursor, selectedRunId, nowIso: new Date((latest.current.now ?? Date.now)()).toISOString() });
    if (switched || selectedRunId !== undefined) navigateSelection(selectedRunId, true);
  }, [scope, commit, navigateSelection]);

  const read = useCallback(async (kind: 'initial' | 'poll' | 'next'): Promise<void> => {
    if (scope.listPage === undefined || !scope.active || scope.suspended || scope.busy || (kind === 'next' && scope.view.nextCursor === undefined)) return;
    const generation = scope.generation;
    scope.busy = true;
    if (kind === 'next') commit({ isPaging: true });
    try {
      const pages = kind === 'poll' ? Math.max(scope.pageCount, 1) : 1;
      let cursor = kind === 'next' ? scope.view.nextCursor : undefined;
      const rows = kind === 'next' ? [...scope.rawRows] : [];
      for (let i = 0; i < pages; i++) {
        const page = await scope.listPage(cursor);
        if (generation !== scope.generation) return;
        // The collection API permits comma-separated filter values, but a string
        // scope represents one project. Do not mix rows on a manually edited URL.
        for (const run of page.runs) {
          if (scope.exactProjectId === undefined || run.projectId === scope.exactProjectId) rows.push(run);
        }
        cursor = page.nextCursor;
        if (cursor === undefined) break;
      }
      commitRows(dedupeRuns(rows), cursor, kind === 'next' ? scope.pageCount + 1 : pages);
      commit({ phase: 'ready' });
      setListLost(false);
    } catch (error) {
      if (generation !== scope.generation) return;
      if (isUnauthorized(error)) {
        latest.current.onUnauthorized?.();
        return;
      }
      if (kind === 'initial') commit({ phase: 'error' });
      setListLost(true);
    } finally {
      if (generation === scope.generation) {
        scope.busy = false;
        if (kind === 'next') commit({ isPaging: false });
        if (kind === 'initial') commit({ started: true });
      }
    }
  }, [scope, commit, commitRows, setListLost]);

  // Reinterpret the retained rows before painting a new active view, even
  // when its effective request does not require a new data scope.
  useLayoutEffect(() => {
    const rows = projectRunViewRows(activeView, scope.rawRows);
    if (rows !== scope.view.rows) commit({ rows });
  }, [activeView, scope, commit]);

  // A new view owns all subsequent reads, even when its effective request is
  // unchanged. Keep the compatible raw rows/cursor but retire old responses.
  const previousViewId = useRef(activeViewId);
  useLayoutEffect(() => {
    if (!connected) return;
    scope.switched ||= previousViewId.current !== activeViewId;
    previousViewId.current = activeViewId;
    scope.active = true;
    if (scope.view.isPaging) commit({ isPaging: false });
    if (scope.listPage === undefined) {
      if (scope.switched) {
        scope.switched = false;
        navigateSelection(undefined, true);
      }
    } else if (latest.current.createdRun === undefined) {
      void read(scope.pageCount > 0 ? 'poll' : 'initial');
    }
    return () => {
      scope.active = false;
      scope.generation++;
      scope.busy = false;
    };
  }, [activeViewId, connected, scope, commit, navigateSelection, read]);

  // A compatible view switch retains the last connection result until refresh.
  // Leaving the request scope retires its connection indicator.
  useLayoutEffect(() => {
    if (!connected) return;
    return () => {
      scope.listLost = false;
      latest.current.onListLostChange(false);
    };
  }, [connected, scope]);

  const { createdRun } = options;
  useLayoutEffect(() => {
    if (!scope.active || scope.listPage === undefined || createdRun === undefined) return;
    scope.rawRows = mergeRunRows(scope.rawRows, [createdRun, ...scope.rawRows.filter((run) => run.id !== createdRun.id)]);
    const rows = projectRunViewRows(latest.current.activeView, scope.rawRows);
    scope.awaitingListRunId = createdRun.id;
    scope.suspended = false;
    commit({
      rows, selectedRunId: resolveInitialSelection(rows.map((row) => row.id), createdRun.id),
      phase: 'ready', started: true, isPaging: false,
      nowIso: new Date((latest.current.now ?? Date.now)()).toISOString()
    });
    void read('poll');
  }, [createdRun, scope, commit, read]);

  useEffect(() => {
    if (!view.started) return;
    const pollIfVisible = (): void => {
      if (document.visibilityState !== 'hidden') void read('poll');
    };
    const id = window.setInterval(pollIfVisible, pollIntervalMs);
    document.addEventListener('visibilitychange', pollIfVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', pollIfVisible);
    };
  }, [view.started, read, pollIntervalMs]);

  // Browser back/forward changes selection without pushing a new entry.
  const { routeRunId } = options;
  useEffect(() => {
    if (view.phase === 'ready' && routeRunId !== undefined && scope.view.selectedRunId !== routeRunId &&
      scope.view.rows.some((row) => row.id === routeRunId)) {
      commit({ selectedRunId: routeRunId });
    }
  }, [routeRunId, view.phase, scope, commit]);

  const loadNextPage = useCallback((): void => { void read('next'); }, [read]);
  const select = useCallback((id: string): void => {
    if (!scope.view.rows.some((row) => row.id === id)) return;
    commit({ selectedRunId: id });
    navigateSelection(id, false);
    if (isSelectionAtEnd(scope.view.rows.map((row) => row.id), id)) loadNextPage();
  }, [scope, commit, navigateSelection, loadNextPage]);

  const move = useCallback((direction: SelectionDirection): void => {
    const ids = scope.view.rows.map((row) => row.id);
    const current = scope.view.selectedRunId;
    const next = moveSelection(ids, current, direction);
    if (next !== undefined && next !== current) {
      commit({ selectedRunId: next });
      navigateSelection(next, false);
    }
    if (direction === 'next' && isSelectionAtEnd(ids, next ?? current)) loadNextPage();
  }, [scope, commit, navigateSelection, loadNextPage]);

  const replaceRun = useCallback((run: Run): void => {
    if (!scope.active) return;
    const rows = replaceRunInRows(scope.rawRows, run);
    if (rows !== scope.rawRows) {
      scope.rawRows = rows;
      commit({ rows: projectRunViewRows(latest.current.activeView, rows) });
    }
  }, [scope, commit]);

  const prepareCreatedRun = useCallback((): void => {
    scope.suspended = true;
    scope.busy = false;
    scope.generation++;
  }, [scope]);

  return { ...view, hasNextPage: view.nextCursor !== undefined, select, move, loadNextPage, replaceRun, prepareCreatedRun };
}
