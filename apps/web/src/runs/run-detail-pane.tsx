/**
 * The Run detail pane: a side complementary region that reflects the selected run with a
 * header, a stable four-tab model (Summary, Spec, Acceptance, Activity), the Summary
 * facts, and live status changes from the control-plane event stream.
 *
 * The selected run is the single source of truth from the run list state (the `run`
 * prop). This component holds no second authoritative run copy: the data hook
 * (`useRunDetail`, owned by the Runs route) rereads the run on transitions and feeds it back through
 * `replaceRun`, which updates both the list row and — because the pane reads the run from
 * that state — the pane. The pane owns only the kept-tab preference, the overlay toggle,
 * and the pane-level spec-review controller.
 *
 * Pane bar: besides staying aligned with the table column header row, the far right holds
 * (when the loaded spec is ready) the full-screen expand button and (at the spec or
 * implementation gate) the one decision button. The spec-tab comment counts and
 * previous/next controls are published to the shell footer through the run-detail footer
 * bridge; when the overlay is open the footer is covered, so those controls move into the
 * overlay and the bridge clears.
 */
import type { Run } from '@autocatalyst/api-contract';
import { Maximize2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';

import { ACCEPTANCE_EMPTY_STATE } from './run-detail-empty-states.js';
import { useRunDetailFooterOptional } from './run-detail-footer.js';
import { RunDetailHeader } from './run-detail-header.js';
import { RunActivity } from './run-activity.js';
import { RunProgress } from './run-progress.js';
import { RunDetailSummary } from './run-detail-summary.js';
import { RunDetailSpecTab } from './run-detail-spec-tab.js';
import { RunDetailSpecOverlay } from './run-detail-spec-overlay.js';
import { RUN_DETAIL_TABS, resolveVisibleTab, tabsForRun, type RunDetailTabId } from './run-detail-tabs.js';
import { ImplementationGateDecision, SpecGateDecision } from './spec-gate-decision.js';
import { decisionErrorInfo, isSpecGateDecisionAvailable } from './spec-decision.js';
import type { RunDetailState } from './use-run-detail.js';
import { useSpecReviewController } from './use-spec-review-controller.js';
import { actionTooltipKey, getAction } from '../shell/action-registry.js';
import { isMacPlatform } from '../shell/key-utils.js';
import { useActionKeys } from '../shell/use-action-keys.js';
import { EmptyState } from '../ui/empty-state.js';
import { Button } from '../ui/button.js';
import { Textarea } from '../ui/textarea.js';
import { Tooltip } from '../ui/tooltip.js';
import { TabPanel, Tabs } from '../ui/tabs.js';

export interface RunDetailPaneProps {
  /** The selected run, or undefined in the no-runs state. Read from the list state. */
  readonly run: Run | undefined;
  readonly detail: RunDetailState;
  /** The loaded current operator principal id, or undefined when unknown (non-fatal). */
  readonly currentPrincipalId?: string;
  readonly currentPrincipalIsHuman?: boolean;
  readonly runActions?: ReactNode;
  readonly actionOutcome?: ReactNode;
  readonly titleEditor?: ReactNode;
  onRename?(opener: HTMLElement): void;
}

const EMPTY_PANE_BAR = <div data-testid="pane-bar" className="h-pane-bar shrink-0 border-b border-border px-3" />;

export function RunDetailPane({
  run,
  detail,
  currentPrincipalId, currentPrincipalIsHuman, runActions, actionOutcome, titleEditor, onRename
}: RunDetailPaneProps): ReactNode {
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
        <RunDetailBody run={run} detail={detail} currentPrincipalId={currentPrincipalId} currentPrincipalIsHuman={currentPrincipalIsHuman}
          runActions={runActions} actionOutcome={actionOutcome} titleEditor={titleEditor} onRename={onRename} />
      )}
    </aside>
  );
}

interface RunDetailBodyProps extends Pick<RunDetailPaneProps, 'runActions' | 'actionOutcome' | 'titleEditor'> {
  readonly run: Run;
  readonly detail: RunDetailState;
  readonly currentPrincipalId: string | undefined;
  readonly currentPrincipalIsHuman: boolean | undefined;
  readonly onRename: RunDetailPaneProps['onRename'];
}

function RunDetailBody({ run, detail, currentPrincipalId, currentPrincipalIsHuman, runActions,
  actionOutcome, titleEditor, onRename }: RunDetailBodyProps): ReactNode {
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
    reopenComment: detail.reopenComment,
    ...(currentPrincipalIsHuman !== undefined ? { currentPrincipalIsHuman } : {}),
    ...(detail.declineFinding ? { declineFinding: detail.declineFinding } : {}),
    ...(detail.specHandoff ? { outstandingModelFindings: detail.specHandoff.outstandingIds } : {})
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

  // Supply live detail eligibility to the same predicates exercised by the
  // registry-wide conflict test. Recheck comment ownership before executing.
  useActionKeys({
    'next-comment': selectNext,
    'previous-comment': selectPrevious,
    'resolve-comment': () => {
      const id = controller.selectedId;
      if (id !== null && controller.canResolve(id)) controller.resolve(id);
    },
    'expand-spec': () => setOverlayOpen(true)
  }, {
    getState: () => ({
      run,
      detailTab: visibleTab,
      specReady,
      canSelectPreviousComment: canPrevious,
      canSelectNextComment: canNext,
      canResolveComment: controller.selectedId !== null && controller.canResolve(controller.selectedId)
    })
  });

  const onApprove = (): ReturnType<typeof detail.replyToGate> => detail.replyToGate('approve');
  const onRequestChanges = (): ReturnType<typeof detail.replyToGate> => detail.replyToGate('request_changes');

  const isMac = isMacPlatform();
  const expandLabel = getAction('expand-spec').name;

  const panelClass = 'min-h-0 flex-1 overflow-auto pb-4 pt-3';
  return (
    <>
      <div data-testid="pane-bar" className="flex h-pane-bar shrink-0 items-center justify-end gap-2 border-b border-border px-3">
        {runActions}
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
        ) : <ImplementationGateDecision run={run} onApprove={onApprove} />}
      </div>

      <div data-testid="pane-body" className="flex min-h-0 flex-1 flex-col">
        <div className="shrink-0 px-4 pb-4 pt-4">
          <RunDetailHeader run={run} editor={titleEditor} {...(onRename === undefined ? {} : { onRename })} />
          {actionOutcome}
          {detail.guidancePause && detail.answerGuidance && currentPrincipalIsHuman !== false ? (
            <GuidanceReply key={detail.guidancePause.stepId} pause={detail.guidancePause} answer={detail.answerGuidance} />
          ) : null}
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
            <RunProgress run={run} workflow={detail.activity.workflow.value} attempts={detail.activity.steps.value} />
            <RunDetailSummary
              run={run}
              pullRequest={detail.pullRequest}
              pullRequestCheck={detail.pullRequestCheck}
              {...(detail.checkPullRequest !== undefined ? { onCheckPullRequest: detail.checkPullRequest } : {})}
              sessions={detail.sessions}
            />
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
          <TabPanel value="activity" className={panelClass} keepMounted>
            <RunActivity run={run} activity={detail.activity} sessions={detail.sessions} active={visibleTab === 'activity'} />
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

function GuidanceReply({ pause, answer }: {
  pause: NonNullable<RunDetailState['guidancePause']>;
  answer: NonNullable<RunDetailState['answerGuidance']>;
}): ReactNode {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <form className="mt-2 space-y-2" onSubmit={event => {
      event.preventDefault();
      if (!body.trim() || busy) return;
      setBusy(true);
      setError(undefined);
      void answer(pause.stepId, body.trim()).then(result => {
        if (result.status === 'error') {
          setError(decisionErrorInfo(result.error).message);
          setBusy(false);
        }
      });
    }}>
      <p className="text-sm">{pause.kind === 'spec' ? `Spec ${pause.role === 'implementer' ? 'author' : 'reviewer'} asks:` : 'CI repair needs guidance:'} {pause.question}</p>
      <Textarea aria-label={pause.kind === 'spec' ? 'Answer spec question' : 'Give CI repair guidance'} value={body} onChange={event => setBody(event.target.value)} rows={2} />
      {error ? <p role="alert" className="text-sm text-red">{error}</p> : null}
      <Button type="submit" disabled={busy || !body.trim()}>Send answer</Button>
    </form>
  );
}
