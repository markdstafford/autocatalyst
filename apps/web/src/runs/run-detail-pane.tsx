/**
 * The Run detail pane: a side complementary region that reflects the selected run with a
 * header, a stable four-tab model (Summary, Spec, Acceptance, Activity), the Summary
 * facts, and live status changes from the control-plane event stream.
 *
 * The selected run is the single source of truth from the run list state (the `run`
 * prop). This component holds no second authoritative run copy: the data hook
 * (`useRunDetail`) rereads the run on every transition and feeds it back through
 * `replaceRun`, which updates both the list row and — because the pane reads the run from
 * that state — the pane. The pane owns only the kept-tab preference and renders the
 * hook's independent fact states.
 *
 * The pane bar stays empty and `--height-pane-bar` high so its top and bottom align with
 * the table column header row. The pane bar, the detail header, and the tab list stay
 * pinned while only the active tab's content scrolls beneath the tab list, so the
 * orientation elements never scroll away. Clamping the title to two lines keeps the fixed
 * header block short. The body and tab content keep 16 px horizontal padding.
 */
import type { ControlPlaneClient } from '@autocatalyst/sdk';
import type { Run } from '@autocatalyst/api-contract';
import { useState, type ReactNode } from 'react';

import { ACCEPTANCE_EMPTY_STATE, ACTIVITY_EMPTY_STATE } from './run-detail-empty-states.js';
import { RunDetailHeader } from './run-detail-header.js';
import { RunDetailSummary } from './run-detail-summary.js';
import { RunDetailSpecTab } from './run-detail-spec-tab.js';
import { RUN_DETAIL_TABS, resolveVisibleTab, tabsForRun, type RunDetailTabId } from './run-detail-tabs.js';
import { useRunDetail } from './use-run-detail.js';
import { EmptyState } from '../ui/empty-state.js';
import { TabPanel, Tabs } from '../ui/tabs.js';

export interface RunDetailPaneProps {
  /** The selected run, or undefined in the no-runs state. Read from the list state. */
  readonly run: Run | undefined;
  /** The SDK client used for the selected-run reads and event stream. */
  readonly client: ControlPlaneClient;
  /** Whether the pane is shown (always true while mounted; drives the stream lifecycle). */
  readonly visible: boolean;
  /** Push an authoritative `getRun` result back into the list state (live-update path). */
  replaceRun(run: Run): void;
  /** Navigate to the connection page on a 401 from the selected-run stream. */
  onUnauthorized(): void;
}

export function RunDetailPane({ run, client, visible, replaceRun, onUnauthorized }: RunDetailPaneProps): ReactNode {
  // The kept-tab preference persists across run-selection changes; a run missing the kept
  // tab falls back to Summary without changing the preference (future item types).
  const [keptTabId, setKeptTabId] = useState<RunDetailTabId>('summary');

  const detail = useRunDetail({ client, run, visible, replaceRun, onUnauthorized });

  return (
    <aside
      role="complementary"
      aria-label="Run detail"
      {...(run !== undefined ? { 'data-pane-run-id': run.id } : {})}
      className="flex h-full min-w-0 flex-col border-l border-border bg-background"
    >
      {/* Empty pane bar; aligns with the table column header row. Stays pinned. */}
      <div data-testid="pane-bar" className="h-pane-bar shrink-0 border-b border-border px-3" />

      <div data-testid="pane-body" className="flex min-h-0 flex-1 flex-col">
        {run === undefined ? (
          <EmptyState data-testid="pane-no-run" title="No run" />
        ) : detail.runGone ? (
          <EmptyState
            data-testid="pane-run-gone"
            title="This run is no longer available"
            message="It may have been removed. Select another run from the list."
          />
        ) : (
          renderContent(run)
        )}
      </div>
    </aside>
  );

  function renderContent(selectedRun: Run): ReactNode {
    const availableTabs = tabsForRun();
    const visibleTab = resolveVisibleTab(keptTabId, availableTabs);
    const tabs = RUN_DETAIL_TABS.filter((tab) => availableTabs.includes(tab.id));
    // The header block stays pinned (shrink-0); the Tabs root fills the rest as a flex column
    // with a pinned tab list (shrink-0) and a scrolling active panel (flex-1 overflow-auto).
    const panelClass = 'min-h-0 flex-1 overflow-auto pb-4 pt-3';
    return (
      <>
        <div className="shrink-0 px-4 pb-4 pt-4">
          <RunDetailHeader run={selectedRun} />
        </div>
        <Tabs
          label="Run detail sections"
          tabs={tabs}
          value={visibleTab}
          className="flex min-h-0 flex-1 flex-col px-4"
          listClassName="shrink-0"
          onValueChange={(next) => {
            setKeptTabId(next as RunDetailTabId);
          }}
        >
          <TabPanel value="summary" className={panelClass}>
            <RunDetailSummary run={selectedRun} pullRequest={detail.pullRequest} sessions={detail.sessions} />
          </TabPanel>
          <TabPanel value="spec" className={panelClass}>
            <RunDetailSpecTab
              spec={detail.spec}
              run={selectedRun}
              onCreateComment={detail.createSpecComment}
              onReloadNeeded={detail.reloadSpec}
            />
          </TabPanel>
          <TabPanel value="acceptance" className={panelClass}>
            <EmptyState
              data-testid="pane-acceptance-empty"
              title={ACCEPTANCE_EMPTY_STATE.title}
              message={ACCEPTANCE_EMPTY_STATE.line}
            />
          </TabPanel>
          <TabPanel value="activity" className={panelClass}>
            <EmptyState
              data-testid="pane-activity-empty"
              title={ACTIVITY_EMPTY_STATE.title}
              message={ACTIVITY_EMPTY_STATE.line}
            />
          </TabPanel>
        </Tabs>
      </>
    );
  }
}
