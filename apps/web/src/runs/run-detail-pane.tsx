/**
 * The Run detail pane: a side complementary region that reflects the selected run with a
 * header, a stable four-tab model (Summary, Spec, Acceptance, Activity), the Summary
 * facts, and live status changes from the control-plane event stream.
 *
 * The selected run is the single source of truth from the run list state (the `run`
 * prop). This component holds no second authoritative run copy: the data hook
 * (`useRunDetail`) rereads the run on every transition and feeds it back through
 * `replaceRun`, which updates both the list row and — because the pane reads the run from
 * that state — the pane. The pane owns only the kept-tab preference, the overlay toggle,
 * and the pane-level spec-review controller.
 *
 * Pane bar: besides staying aligned with the table column header row, the far right holds
 * (when the loaded spec is ready) the full-screen expand button and (while the run waits at
 * `spec.human_review`) the one gate decision button. The spec-tab comment counts and
 * previous/next controls are published to the shell footer through the run-detail footer
 * bridge; when the overlay is open the footer is covered, so those controls move into the
 * overlay and the bridge clears.
 */
import type { ControlPlaneClient } from '@autocatalyst/sdk';
import type { Run } from '@autocatalyst/api-contract';
import { Maximize2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';

import { ACCEPTANCE_EMPTY_STATE, ACTIVITY_EMPTY_STATE } from './run-detail-empty-states.js';
import { useRunDetailFooterOptional } from './run-detail-footer.js';
import { RunDetailHeader } from './run-detail-header.js';
import { RunDetailSummary } from './run-detail-summary.js';
import { RunDetailSpecTab } from './run-detail-spec-tab.js';
import { RunDetailSpecOverlay } from './run-detail-spec-overlay.js';
import { RUN_DETAIL_TABS, resolveVisibleTab, tabsForRun, type RunDetailTabId } from './run-detail-tabs.js';
import { SpecGateDecision } from './spec-gate-decision.js';
import { isSpecGateDecisionAvailable } from './spec-decision.js';
import { useRunDetail, type RunDetailState } from './use-run-detail.js';
import { useSpecReviewController } from './use-spec-review-controller.js';
import { actionTooltipKey, getAction } from '../shell/action-registry.js';
import { isMacPlatform } from '../shell/key-utils.js';
import { useActionKeys } from '../shell/use-action-keys.js';
import { EmptyState } from '../ui/empty-state.js';
import { Button } from '../ui/button.js';
import { Tooltip } from '../ui/tooltip.js';
import { TabPanel, Tabs } from '../ui/tabs.js';

export interface RunDetailPaneProps {
  /** The selected run, or undefined in the no-runs state. Read from the list state. */
  readonly run: Run | undefined;
  /** The SDK client used for the selected-run reads and event stream. */
  readonly client: ControlPlaneClient;
  /** Whether the pane is shown (always true while mounted; drives the stream lifecycle). */
  readonly visible: boolean;
  /** The loaded current operator principal id, or undefined when unknown (non-fatal). */
  readonly currentPrincipalId?: string;
  /** Push an authoritative `getRun` result back into the list state (live-update path). */
  replaceRun(run: Run): void;
  /** Navigate to the connection page on a 401 from the selected-run stream. */
  onUnauthorized(): void;
}

const EMPTY_PANE_BAR = <div data-testid="pane-bar" className="h-pane-bar shrink-0 border-b border-border px-3" />;

export function RunDetailPane({
  run,
  client,
  visible,
  currentPrincipalId,
  replaceRun,
  onUnauthorized
}: RunDetailPaneProps): ReactNode {
  const detail = useRunDetail({ client, run, visible, replaceRun, onUnauthorized });

  return (
    <aside
      role="complementary"
      aria-label="Run detail"
      {...(run !== undefined ? { 'data-pane-run-id': run.id } : {})}
      className="flex h-full min-w-0 flex-col border-l border-border bg-background"
    >
      {run === undefined ? (
        <>
          {EMPTY_PANE_BAR}
          <div data-testid="pane-body" className="flex min-h-0 flex-1 flex-col">
            <EmptyState data-testid="pane-no-run" title="No run" />
          </div>
        </>
      ) : detail.runGone ? (
        <>
          {EMPTY_PANE_BAR}
          <div data-testid="pane-body" className="flex min-h-0 flex-1 flex-col">
            <EmptyState
              data-testid="pane-run-gone"
              title="This run is no longer available"
              message="It may have been removed. Select another run from the list."
            />
          </div>
        </>
      ) : (
        <RunDetailBody run={run} detail={detail} currentPrincipalId={currentPrincipalId} />
      )}
    </aside>
  );
}

interface RunDetailBodyProps {
  readonly run: Run;
  readonly detail: RunDetailState;
  readonly currentPrincipalId: string | undefined;
}

function RunDetailBody({ run, detail, currentPrincipalId }: RunDetailBodyProps): ReactNode {
  const [keptTabId, setKeptTabId] = useState<RunDetailTabId>('summary');
  const [overlayOpen, setOverlayOpen] = useState(false);

  const spec = detail.spec;
  const specReady = spec.status === 'ready';
  const specMarkdown = spec.status === 'ready' ? spec.markdown : '';
  const specArtifactId = spec.status === 'ready' ? spec.artifactId : '';
  const specFeedback = spec.status === 'ready' ? spec.feedback : [];

  const controller = useSpecReviewController({
    feedback: specFeedback,
    markdown: specMarkdown,
    run,
    currentPrincipalId,
    resolveComment: detail.resolveComment,
    reopenComment: detail.reopenComment
  });

  const availableTabs = tabsForRun();
  const visibleTab = resolveVisibleTab(keptTabId, availableTabs);
  const tabs = RUN_DETAIL_TABS.filter((tab) => availableTabs.includes(tab.id));

  const showDecision = isSpecGateDecisionAvailable(run) && specReady;
  const showExpand = visibleTab === 'spec' && specReady;
  const footerActive = visibleTab === 'spec' && specReady && !overlayOpen;

  // Close the overlay when the selected run changes so a stale run's full-screen view never lingers.
  useEffect(() => {
    setOverlayOpen(false);
  }, [run.id]);

  // Publish the spec-tab comment counts and prev/next controls to the shell footer, and clear them
  // whenever the Spec tab is inactive, the spec is not ready, the overlay is open, or the pane unmounts.
  const footer = useRunDetailFooterOptional();
  const setFooterContent = footer?.setContent;
  const { openCount, resolvedCount, hasComments, canPrevious, canNext, selectPrevious, selectNext } = controller;
  useEffect(() => {
    if (setFooterContent === undefined) {
      return;
    }
    if (footerActive) {
      setFooterContent({ openCount, resolvedCount, hasComments, canPrevious, canNext, onPrevious: selectPrevious, onNext: selectNext });
    } else {
      setFooterContent(null);
    }
    return () => setFooterContent(null);
  }, [setFooterContent, footerActive, openCount, resolvedCount, hasComments, canPrevious, canNext, selectPrevious, selectNext]);

  // Keyboard handlers for the spec actions, registered only while the Spec tab is active and the spec
  // is ready; the registry suppresses them in text entry, menus, and the expanded dialog, and these
  // handler-level guards keep them inert otherwise.
  const specKeysActive = visibleTab === 'spec' && specReady;
  useActionKeys(
    specKeysActive
      ? {
          'next-comment': () => controller.selectNext(),
          'previous-comment': () => controller.selectPrevious(),
          'resolve-comment': () => {
            const id = controller.selectedId;
            if (id !== null && controller.canResolve(id)) {
              controller.resolve(id);
            }
          },
          'expand-spec': () => setOverlayOpen(true)
        }
      : {}
  );

  const onApprove = (): ReturnType<typeof detail.replyToGate> => detail.replyToGate('approve');
  const onRequestChanges = (): ReturnType<typeof detail.replyToGate> => detail.replyToGate('request_changes');

  const isMac = isMacPlatform();
  const expandLabel = getAction('expand-spec').name;

  const panelClass = 'min-h-0 flex-1 overflow-auto pb-4 pt-3';
  return (
    <>
      <div data-testid="pane-bar" className="flex h-pane-bar shrink-0 items-center justify-end gap-2 border-b border-border px-3">
        {showExpand ? (
          <Tooltip label={expandLabel} keyHint={actionTooltipKey('expand-spec', isMac)}>
            <Button
              variant="secondary"
              size="control-sm"
              data-testid="spec-expand"
              aria-label={expandLabel}
              onClick={() => setOverlayOpen(true)}
              className="aspect-square border-0 bg-transparent px-0 text-subtext hover:bg-hover hover:text-text"
            >
              <Maximize2 aria-hidden size={14} />
            </Button>
          </Tooltip>
        ) : null}
        {showDecision ? (
          <SpecGateDecision
            run={run}
            feedback={specFeedback}
            currentPrincipalId={currentPrincipalId}
            onApprove={onApprove}
            onRequestChanges={onRequestChanges}
          />
        ) : null}
      </div>

      <div data-testid="pane-body" className="flex min-h-0 flex-1 flex-col">
        <div className="shrink-0 px-4 pb-4 pt-4">
          <RunDetailHeader run={run} />
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
            <RunDetailSummary run={run} pullRequest={detail.pullRequest} sessions={detail.sessions} />
          </TabPanel>
          <TabPanel value="spec" className={panelClass}>
            {overlayOpen ? (
              <div data-testid="pane-spec-expanded" className="flex h-full items-center justify-center p-6 text-sm text-subtext">
                Viewing the spec in full screen.
              </div>
            ) : (
              <RunDetailSpecTab
                spec={detail.spec}
                run={run}
                controller={controller}
                onCreateComment={detail.createSpecComment}
                onReloadNeeded={detail.reloadSpec}
              />
            )}
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
      </div>

      {specReady ? (
        <RunDetailSpecOverlay
          open={overlayOpen}
          onClose={() => setOverlayOpen(false)}
          run={run}
          markdown={specMarkdown}
          artifactId={specArtifactId}
          feedback={specFeedback}
          controller={controller}
          currentPrincipalId={currentPrincipalId}
          onApprove={onApprove}
          onRequestChanges={onRequestChanges}
          onCreateComment={detail.createSpecComment}
          onReloadNeeded={detail.reloadSpec}
        />
      ) : null}
    </>
  );
}
