/**
 * The Summary tab: a compact fact list of the details the header does not already own.
 * The header carries the issue, work kind, and state, so Summary shows only the step (for
 * an in-progress run), the failure reason (for a failed run), the pull request, and the
 * time, tokens, and cost totals. The pane renders workflow progress above this fact list.
 *
 * Each fact renders its own loading, success, and error state, so a failed pull request
 * or sessions read shows an inline message on that fact alone and never blanks the
 * others. The step and failure facts come straight from the selected run, which the list
 * already loaded. Time and tokens use the recorded sessions; Cost uses the API subtotal.
 */
import type { Run } from '@autocatalyst/api-contract';
import { LoaderCircle } from 'lucide-react';
import type { ReactNode } from 'react';

import { CELL_DASH } from './run-fields.js';
import type { PullRequestCheck, PullRequestFact, SessionsFact } from './run-detail-facts.js';
import { formatRunFailureReason } from './run-failure-reason.js';
import { describeRunCost, formatDurationMs, formatNanoUsd, summaryDuration, summaryTokens } from './run-summary-totals.js';
import { DescriptionItem, DescriptionList } from '../ui/description-list.js';
import { Button } from '../ui/button.js';
import { Tooltip } from '../ui/tooltip.js';

export interface RunDetailSummaryProps {
  readonly run: Run;
  readonly pullRequest: PullRequestFact;
  readonly pullRequestCheck?: PullRequestCheck;
  readonly onCheckPullRequest?: () => void;
  readonly sessions: SessionsFact;
}

export function RunDetailSummary({
  run, pullRequest, pullRequestCheck = {}, onCheckPullRequest, sessions
}: RunDetailSummaryProps): ReactNode {
  const failureReason = run.status === 'failed' ? formatRunFailureReason(run.failureReason) : undefined;
  return (
    <DescriptionList data-testid="pane-summary">
      {run.status === 'in_progress' ? (
        <DescriptionItem label="Step">
          <span data-testid="pane-summary-step" className="font-mono">
            {run.currentStep}
          </span>
        </DescriptionItem>
      ) : null}
      {failureReason !== undefined ? (
        <DescriptionItem label="Failure">
          <span data-testid="pane-summary-failure" className="text-red">
            {failureReason}
          </span>
        </DescriptionItem>
      ) : null}
      <DescriptionItem label="Pull request">
        {renderPullRequest(pullRequest, pullRequestCheck, onCheckPullRequest)}
      </DescriptionItem>
      <DescriptionItem label="Time">{renderTime(sessions)}</DescriptionItem>
      <DescriptionItem label="Tokens">{renderTokens(sessions)}</DescriptionItem>
      <DescriptionItem label="Cost">{renderCost(sessions, run.status === 'in_progress')}</DescriptionItem>
    </DescriptionList>
  );
}

const PR_STATE = {
  open: { label: 'Open', color: 'text-subtext' },
  merged: { label: 'Merged', color: 'text-green' },
  closed: { label: 'Closed', color: 'text-red' }
} as const;

function renderPullRequest(fact: PullRequestFact, check: PullRequestCheck, onCheck: (() => void) | undefined): ReactNode {
  if (fact.status === 'loading') {
    return <span data-testid="pane-summary-pr" className="text-subtext">Loading…</span>;
  }
  if (fact.status === 'error') {
    return (
      <span data-testid="pane-summary-pr-error" className="text-red">
        {fact.message}
      </span>
    );
  }
  if (fact.value === null) {
    return <span data-testid="pane-summary-pr">{CELL_DASH}</span>;
  }
  const pr = fact.value;
  const { label, color } = PR_STATE[pr.state];
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <a
          data-testid="pane-summary-pr"
          href={pr.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-text hover:underline"
        >
          #{pr.number} · <span className={color} aria-live="polite">{label}</span>
        </a>
        {onCheck !== undefined ? (
          <Button variant="secondary" size="control-sm" aria-disabled={check.pending || check.locked} onClick={onCheck}>
            Check now
          </Button>
        ) : null}
      </div>
      <div role="status" className="text-xs text-subtext">
        {check.pending ? (
          <span className="inline-flex items-center gap-1">
            <LoaderCircle size={12} className="motion-safe:animate-spin" aria-hidden="true" /> Checking
          </span>
        ) : check.error !== undefined ? (
          <span className="text-red">{check.error}</span>
        ) : check.checkedAt !== undefined ? 'Checked just now' : null}
        {check.checkedAt !== undefined ? (
          <span className="block">
            Last checked: <time dateTime={check.checkedAt}>{new Date(check.checkedAt).toLocaleTimeString()}</time>
          </span>
        ) : null}
      </div>
    </>
  );
}

function renderTime(fact: SessionsFact): ReactNode {
  if (fact.status === 'loading') {
    return <span data-testid="pane-summary-time" className="text-subtext">Loading…</span>;
  }
  if (fact.status === 'error') {
    return (
      <span data-testid="pane-summary-time-error" className="text-red">
        {fact.message}
      </span>
    );
  }
  const duration = summaryDuration(fact.value);
  return (
    <span data-testid="pane-summary-time" className="tabular-nums">
      {duration === null ? CELL_DASH : formatDurationMs(duration)}
    </span>
  );
}

function renderTokens(fact: SessionsFact): ReactNode {
  if (fact.status === 'loading') {
    return <span data-testid="pane-summary-tokens" className="text-subtext">Loading…</span>;
  }
  if (fact.status === 'error') {
    return (
      <span data-testid="pane-summary-tokens-error" className="text-red">
        {fact.message}
      </span>
    );
  }
  if (fact.value.length === 0) {
    return <span data-testid="pane-summary-tokens" className="tabular-nums">{CELL_DASH}</span>;
  }
  const tokens = summaryTokens(fact.value);
  return (
    <Tooltip label={tokens.detail} delay={0}>
      <span data-testid="pane-summary-tokens" tabIndex={0} className="tabular-nums underline decoration-dotted">
        {tokens.text}
      </span>
    </Tooltip>
  );
}

function renderCost(fact: SessionsFact, running: boolean): ReactNode {
  if (fact.status === 'loading') {
    return <span data-testid="pane-summary-cost" className="text-subtext">Loading…</span>;
  }
  if (fact.status === 'error') {
    return (
      <span data-testid="pane-summary-cost-error" className="text-red">
        {fact.message}
      </span>
    );
  }
  const progress = running ? ' so far' : '';
  const total = fact.runCost;
  if ((total?.sessionCount ?? fact.value.length) === 0) {
    return <span data-testid="pane-summary-cost" className="tabular-nums" aria-label={'No recorded sessions' + progress}>{CELL_DASH}</span>;
  }
  if (total === undefined) {
    return <span data-testid="pane-summary-cost">Pricing unavailable{progress}</span>;
  }
  const amount = total.knownSubtotalUsd === null ? 'Unknown' : formatNanoUsd(total.knownSubtotalUsd);
  const estimates = total.gaps.some(({ code }) => code === 'estimated_request_size');
  return (
    <Tooltip label={describeRunCost(total)} delay={0}>
      <span data-testid="pane-summary-cost" tabIndex={0} className="tabular-nums underline decoration-dotted">
        {amount}{progress} · API list price{!total.complete ? ' · Incomplete' : ''}{estimates ? ' · Includes estimates' : ''}
      </span>
    </Tooltip>
  );
}
