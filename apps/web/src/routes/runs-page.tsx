/**
 * The Runs destination: the active named view of the run collection.
 *
 * It composes the run list state module ({@link useRunList}) with the table, the side
 * detail pane, and the resize separator, and renders the loading, no-runs, and
 * first-page-failure states. Selection drives the address (`/runs/:runId`) and the
 * pane, and the pane's shown/hidden state and width come from the shell through the
 * outlet context.
 *
 * Connection: without a stored bearer token the page shows the connect empty state and
 * starts no request or timer (the state module's no-token path). A current `401`
 * from a list or project read flips the provider's authorization to `unauthorized`; this page
 * observes that and navigates to the connection page. The run list writes only the
 * shell `listLost` flag, which the footer reads.
 */
import type { Run } from '@autocatalyst/api-contract';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate, useOutletContext, useParams } from 'react-router-dom';

import { hasBearerToken } from '../auth/token-store.js';
import { useControlPlaneConnection } from '../client/client-provider.js';
import { useProjectDirectory } from '../projects/project-directory.js';
import { ProjectEmptyState } from '../projects/project-empty-state.js';
import { RunActionDialogs, RunActionOutcomeLine, RunActionsMenu, RunTitleEditor } from '../runs/run-action-surfaces.js';
import { RunDetailPane } from '../runs/run-detail-pane.js';
import { buildProjectNameMap, referencedProjectIds } from '../runs/run-list-projects.js';
import { RunTable } from '../runs/run-table.js';
import { useCurrentPrincipal } from '../runs/use-current-principal.js';
import { useRunDetail } from '../runs/use-run-detail.js';
import { useRunActions } from '../runs/use-run-actions.js';
import { useRunList } from '../runs/use-run-list.js';
import { useConnectionState } from '../shell/connection-state.js';
import { CONNECTION_PATH, RUNS_PATH, isArchivedRunsSearch, projectIdFromSearch, projectRunsPath, runPath } from '../shell/navigation.js';
import { useActionKeys } from '../shell/use-action-keys.js';
import type { RunsOutletContext } from '../shell/shell-layout.js';
import { PANE_WIDTH_MAX, PANE_WIDTH_MIN } from '../theme/preferences.js';
import { Button } from '../ui/button.js';
import { EmptyState } from '../ui/empty-state.js';
import { ResizeHandle } from '../ui/resize-handle.js';

export function RunsPage(): ReactNode {
  const navigate = useNavigate();
  const location = useLocation();
  const archivedOnly = isArchivedRunsSearch(location.search);
  const projectId = archivedOnly ? undefined : projectIdFromSearch(location.search);
  const { runId: routeRunId } = useParams();
  const connected = hasBearerToken();
  const { client, authorization, reportListUnauthorized } = useControlPlaneConnection();
  const canRead = connected && authorization !== 'unauthorized';
  const currentPrincipal = useCurrentPrincipal(client, canRead);
  const { setListLost } = useConnectionState();
  const { detailPaneVisible, revealDetailPane, sidePaneWidthPx, setPaneWidth, startRunOpen, openStartRun, receiveCreatedRun, activeView } = useOutletContext<RunsOutletContext>();
  const mainRef = useRef<HTMLDivElement | null>(null);
  const [handoff, setHandoff] = useState<{
    readonly run: Run;
    readonly client: typeof client;
    readonly projectId: string | undefined;
  }>();
  const createdRun = handoff !== undefined && handoff.client === client &&
    routeRunId === handoff.run.id && handoff.projectId === projectId ? handoff.run : undefined;

  const navigateToRun = useCallback(
    (id: string | undefined, options: { readonly replace: boolean }): void => {
      navigate({ pathname: id === undefined ? RUNS_PATH : runPath(id), search: location.search }, options);
    },
    [navigate, location.search]
  );

  const state = useRunList({
    client,
    connected: canRead,
    routeRunId,
    navigateToRun,
    onListLostChange: setListLost,
    ...(createdRun !== undefined ? { createdRun } : {}),
    activeView,
    projectId,
    archivedOnly,
    onUnauthorized: () => reportListUnauthorized(client)
  });

  const { prepareCreatedRun } = state;
  useLayoutEffect(() => {
    receiveCreatedRun.current = (run) => {
      prepareCreatedRun();
      const destinationProjectId = projectId === run.projectId ? projectId : undefined;
      setHandoff({ run, client, projectId: destinationProjectId });
      const path = runPath(run.id);
      navigate(destinationProjectId === undefined ? path : projectRunsPath(destinationProjectId, path));
    };
    return () => { receiveCreatedRun.current = null; };
  }, [receiveCreatedRun, prepareCreatedRun, client, projectId, navigate]);

  // The handoff is only for the first landing, not later history traversal.
  useEffect(() => {
    if (createdRun !== undefined) setHandoff(undefined);
  }, [createdRun]);

  const { phase: projectsPhase, projects, lookup, refresh } = useProjectDirectory();
  const projectNames = useMemo(() => buildProjectNameMap(projects), [projects]);
  useEffect(() => {
    if (!canRead) return;
    const ids = referencedProjectIds(state.rows);
    if (projectId !== undefined) ids.push(projectId);
    lookup(ids);
  }, [canRead, state.rows, projectId, lookup]);

  // Detail reads and check state belong to the selection even while the pane is closed.
  const selectedRun: Run | undefined = canRead ? state.rows.find((run) => run.id === state.selectedRunId) : undefined;
  const detail = useRunDetail({
    run: selectedRun,
    client,
    visible: detailPaneVisible,
    principalId: currentPrincipal?.id,
    authorized: canRead,
    replaceRun: state.replaceRun,
    readScope: state.actionScope,
    getRunReadVersion: state.getRunReadVersion,
    onUnauthorized: () => { if (!startRunOpen) navigate(CONNECTION_PATH); }
  });
  const actions = useRunActions({
    client, list: state, selectedRun, selectedSteps: detail.actionSteps, startRunOpen,
    revealPane: revealDetailPane, refreshDetail: detail.reloadSpec,
    fallbackFocus: () => mainRef.current?.querySelector<HTMLElement>('[data-run-id][aria-selected="true"]') ?? mainRef.current
  });

  // The run list owns the selection keys. The registry gates `j`/`k`/arrows on focus
  // being inside the list, so binding them here (not at the shell scope) keeps the
  // shell and the list as separate key owners.
  const selectedIndex = state.rows.findIndex((row) => row.id === state.selectedRunId);
  useActionKeys({
    'select-next': () => {
      state.move('next');
    },
    'select-previous': () => {
      state.move('previous');
    }
  }, {
    getState: () => ({
      canSelectNext: selectedIndex >= 0 && (selectedIndex < state.rows.length - 1 || state.hasNextPage),
      canSelectPrevious: selectedIndex > 0
    })
  });

  // A 401 is an authorization state, not a lost connection. While the dialog is open
  // it owns recovery; otherwise keep the Runs route's redirect to Connection settings.
  useEffect(() => {
    if (!startRunOpen && authorization === 'unauthorized') {
      navigate(CONNECTION_PATH);
    }
  }, [authorization, navigate, startRunOpen]);

  const onResize = useCallback(
    (nextWidthPx: number): void => {
      setPaneWidth(nextWidthPx, mainRef.current?.clientWidth);
    },
    [setPaneWidth]
  );

  if (!connected) {
    return (
      <EmptyState
        title="Connect to the control plane"
        message="Enter a bearer token in Connection settings to reach the control plane."
        action={{
          label: 'Open connection settings',
          onClick: () => {
            navigate(CONNECTION_PATH);
          }
        }}
      />
    );
  }

  const hasRows = state.rows.length > 0;
  if (!archivedOnly && !hasRows && projectsPhase === 'ready' && projects.length === 0 &&
    state.phase === 'ready' && actions.outcome === undefined) {
    return <ProjectEmptyState fromRuns />;
  }
  const hasPaneHeader = detailPaneVisible && selectedRun !== undefined && !detail.runGone;
  const outcome = <RunActionOutcomeLine outcome={actions.outcome} undo={actions.undo} />;

  return (
    <div ref={mainRef} tabIndex={-1} className="flex h-full min-w-0 focus:outline-none">
      <div className="flex min-w-0 flex-1 flex-col">
        {!hasPaneHeader && actions.outcome !== undefined ? <div className="shrink-0 px-3">{outcome}</div> : null}
        {renderListRegion()}
      </div>

      {detailPaneVisible ? (
        <>
          <ResizeHandle
            orientation="vertical"
            value={sidePaneWidthPx}
            min={PANE_WIDTH_MIN}
            max={PANE_WIDTH_MAX}
            label="Resize detail pane"
            startAxisChange="increase"
            onResize={onResize}
          />
          <div className="shrink-0" style={{ width: `${sidePaneWidthPx}px` }}>
            <RunDetailPane
              run={selectedRun}
              detail={detail}
              runActions={selectedRun === undefined ? null : <RunActionsMenu run={selectedRun} actions={actions} />}
              actionOutcome={hasPaneHeader ? outcome : null}
              titleEditor={actions.editor === undefined ? null : (
                <RunTitleEditor {...actions.editor} pending={actions.pending} dismiss={actions.dismiss} submit={actions.submit} />
              )}
              {...(selectedRun === undefined ? {} : { onRename: (opener: HTMLElement) => actions.rename(selectedRun, opener) })}
              {...(currentPrincipal !== undefined ? { currentPrincipalId: currentPrincipal.id, currentPrincipalIsHuman: currentPrincipal.kind === 'human' } : {})}
            />
          </div>
        </>
      ) : null}
      <RunActionDialogs actions={actions} />
    </div>
  );

  function renderListRegion(): ReactNode {
    if (hasRows) {
      return (
        <RunTable
          rows={state.rows}
          selectedRunId={state.selectedRunId}
          projectNames={projectNames}
          nowIso={state.nowIso}
          hasNextPage={state.hasNextPage}
          isPaging={state.isPaging}
          select={state.select}
          loadNextPage={state.loadNextPage}
          renderActions={(run, title) => <RunActionsMenu run={run} rowTitle={title} actions={actions} />}
        />
      );
    }
    if (state.phase !== 'error' && (state.phase === 'loading' || (!archivedOnly && projectsPhase === 'loading'))) {
      return (
        <div
          data-testid="runs-loading"
          className="flex h-full items-center justify-center p-6 text-sm text-subtext"
        >
          Loading runs…
        </div>
      );
    }
    if (state.phase === 'error') {
      return (
        <div
          data-testid="runs-error"
          className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center"
        >
          <h2 className="text-md font-medium text-text">Runs could not be loaded</h2>
          <p className="text-sm text-subtext">The client will try again on the next poll.</p>
        </div>
      );
    }
    if (archivedOnly) return <EmptyState title="Archived runs appear here." />;
    if (projectsPhase === 'error') {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
          <h2 className="text-md font-medium text-text">Projects could not be loaded</h2>
          <Button variant="secondary" onClick={() => { void refresh(); }}>Retry</Button>
        </div>
      );
    }
    // Ready with no rows: the same dialog is also available from the sidebar.
    return (
      <EmptyState
        data-testid="runs-empty-no-runs"
        title="No runs yet"
        message="A run starts from a tracked issue."
        action={{ label: 'Start a run', onClick: openStartRun }}
      />
    );
  }
}
