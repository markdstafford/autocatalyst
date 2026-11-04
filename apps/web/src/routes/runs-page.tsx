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
import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { useNavigate, useOutletContext, useParams } from 'react-router-dom';

import { hasBearerToken } from '../auth/token-store.js';
import { useControlPlaneConnection } from '../client/client-provider.js';
import { RunDetailPane } from '../runs/run-detail-pane.js';
import { RunSeparator } from '../runs/run-separator.js';
import { RunTable } from '../runs/run-table.js';
import { useRunList } from '../runs/use-run-list.js';
import { useConnectionState } from '../shell/connection-state.js';
import { CONNECTION_PATH, runPath } from '../shell/navigation.js';
import { useActionKeys } from '../shell/use-action-keys.js';
import type { RunsOutletContext } from '../shell/shell-layout.js';
import { PANE_WIDTH_MAX, PANE_WIDTH_MIN } from '../theme/preferences.js';
import { Button } from '../ui/button.js';

export function RunsPage(): ReactNode {
  const navigate = useNavigate();
  const { runId: routeRunId } = useParams();
  const connected = hasBearerToken();
  const { client, authorization } = useControlPlaneConnection();
  const { setListLost } = useConnectionState();
  const { detailPaneVisible, sidePaneWidthPx, setPaneWidth } = useOutletContext<RunsOutletContext>();
  const mainRef = useRef<HTMLDivElement | null>(null);

  const navigateToRun = useCallback(
    (id: string, options: { readonly replace: boolean }): void => {
      navigate(runPath(id), { replace: options.replace });
    },
    [navigate]
  );

  const state = useRunList({
    client,
    connected,
    routeRunId,
    navigateToRun,
    onListLostChange: setListLost
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

  // A 401 is an authorization state, not a lost connection: route to the connection
  // page. Polling stops because this route unmounts.
  useEffect(() => {
    if (authorization === 'unauthorized') {
      navigate(CONNECTION_PATH);
    }
  }, [authorization, navigate]);

  const onResize = useCallback(
    (nextWidthPx: number): void => {
      setPaneWidth(nextWidthPx, mainRef.current?.clientWidth);
    },
    [setPaneWidth]
  );

  if (!connected) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <h2 className="text-md font-medium text-text">Connect to the control plane</h2>
        <p className="text-sm text-subtext" style={{ maxWidth: 'var(--width-reading-column)' }}>
          Enter a bearer token in Connection settings to reach the control plane.
        </p>
        <Button
          variant="primary"
          className="mt-2"
          onClick={() => {
            navigate(CONNECTION_PATH);
          }}
        >
          Open connection settings
        </Button>
      </div>
    );
  }

  const selectedRun: Run | undefined = state.rows.find((run) => run.id === state.selectedRunId);
  const hasRows = state.rows.length > 0;

  return (
    <div ref={mainRef} className="flex h-full min-w-0">
      <div className="flex min-w-0 flex-1 flex-col">
        {renderListRegion()}
      </div>

      {detailPaneVisible ? (
        <>
          <RunSeparator
            widthPx={sidePaneWidthPx}
            minPx={PANE_WIDTH_MIN}
            maxPx={PANE_WIDTH_MAX}
            onResize={onResize}
          />
          <div className="shrink-0" style={{ width: `${sidePaneWidthPx}px` }}>
            <RunDetailPane
              run={selectedRun}
              client={client}
              visible={detailPaneVisible}
              replaceRun={state.replaceRun}
              onUnauthorized={() => {
                navigate(CONNECTION_PATH);
              }}
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
          projectNames={state.projectNames}
          nowIso={state.nowIso}
          hasNextPage={state.hasNextPage}
          isPaging={state.isPaging}
          select={state.select}
          loadNextPage={state.loadNextPage}
        />
      );
    }
    if (state.phase === 'loading') {
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
    // Ready with no rows: the design-system no-runs empty state, no Start a run button.
    return (
      <div
        data-testid="runs-empty-no-runs"
        className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center"
      >
        <h2 className="text-md font-medium text-text">No runs yet</h2>
        <p className="text-sm text-subtext">A run starts from a tracked issue.</p>
      </div>
    );
  }
}
