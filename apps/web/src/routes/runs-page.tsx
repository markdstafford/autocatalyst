/**
 * The Runs destination: the first complete all-runs collection screen.
 *
 * It composes the run list state module ({@link useRunList}) with the table, the side
 * detail pane, and the resize separator, and renders the loading, no-runs, and
 * first-page-failure states. Selection drives the address (`/runs/:runId`) and the
 * pane, and the pane's shown/hidden state and width come from the shell through the
 * outlet context.
 *
 * Connection: without a stored bearer token the page shows the connect empty state and
 * starts no request or timer (the state module's no-token path). A `401` from the list
 * or project calls flips the provider's authorization to `unauthorized`; this page
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
import { RunDetailPane } from '../runs/run-detail-pane.js';
import { buildProjectNameMap, referencedProjectIds } from '../runs/run-list-projects.js';
import { RunTable } from '../runs/run-table.js';
import { useCurrentPrincipal } from '../runs/use-current-principal.js';
import { useRunDetail } from '../runs/use-run-detail.js';
import { useRunList } from '../runs/use-run-list.js';
import { useConnectionState } from '../shell/connection-state.js';
import { CONNECTION_PATH, projectIdFromSearch, projectRunsPath, runPath } from '../shell/navigation.js';
import { useActionKeys } from '../shell/use-action-keys.js';
import type { RunsOutletContext } from '../shell/shell-layout.js';
import { PANE_WIDTH_MAX, PANE_WIDTH_MIN } from '../theme/preferences.js';
import { Button } from '../ui/button.js';
import { EmptyState } from '../ui/empty-state.js';
import { ResizeHandle } from '../ui/resize-handle.js';

export function RunsPage(): ReactNode {
  const navigate = useNavigate();
  const location = useLocation();
  const projectId = projectIdFromSearch(location.search);
  const { runId: routeRunId } = useParams();
  const connected = hasBearerToken();
  const { client, authorization } = useControlPlaneConnection();
  const canRead = connected && authorization !== 'unauthorized';
  const currentPrincipal = useCurrentPrincipal(client, canRead);
  const { setListLost } = useConnectionState();
  const { detailPaneVisible, sidePaneWidthPx, setPaneWidth, startRunOpen, openStartRun, receiveCreatedRun } = useOutletContext<RunsOutletContext>();
  const mainRef = useRef<HTMLDivElement | null>(null);
  const [handoff, setHandoff] = useState<{
    readonly run: Run;
    readonly client: typeof client;
    readonly projectId: string | undefined;
  }>();
  const createdRun = handoff !== undefined && handoff.client === client &&
    routeRunId === handoff.run.id && handoff.projectId === projectId ? handoff.run : undefined;

  const navigateToRun = useCallback(
    (id: string, options: { readonly replace: boolean }): void => {
      const path = runPath(id);
      navigate(projectId === undefined ? path : projectRunsPath(projectId, path), options);
    },
    [navigate, projectId]
  );

  const state = useRunList({
    client,
    connected: canRead,
    routeRunId,
    navigateToRun,
    onListLostChange: setListLost,
    ...(createdRun !== undefined ? { createdRun } : {}),
    ...(projectId !== undefined ? { requestArgs: { projectId } } : {})
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
    replaceRun: state.replaceRun,
    onUnauthorized: () => { if (!startRunOpen) navigate(CONNECTION_PATH); }
  });

  // The run list owns the selection keys. The registry gates `j`/`k`/arrows on focus
  // being inside the list, so binding them here (not at the shell scope) keeps the
  // shell and the list as separate key owners. `move` is a no-op without rows.
  useActionKeys({
    'select-next': () => {
      state.move('next');
    },
    'select-previous': () => {
      state.move('previous');
    }
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
  if (!hasRows && projectsPhase === 'ready' && projects.length === 0 && state.phase === 'ready') {
    return <ProjectEmptyState fromRuns />;
  }

  return (
    <div ref={mainRef} className="flex h-full min-w-0">
      <div className="flex min-w-0 flex-1 flex-col">
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
              {...(currentPrincipal !== undefined ? { currentPrincipalId: currentPrincipal.id, currentPrincipalIsHuman: currentPrincipal.kind === 'human' } : {})}
            />
          </div>
        </>
      ) : null}
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
        />
      );
    }
    if (state.phase !== 'error' && (state.phase === 'loading' || projectsPhase === 'loading')) {
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
