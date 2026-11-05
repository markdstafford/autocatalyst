/**
 * The Summary tab: a compact fact list of the details the header does not already own.
 * The header carries the issue, work kind, and state, so Summary shows only the step (for
 * an in-progress run), the failure reason (for a failed run), the pull request, and the
 * time, tokens, and cost totals. It is a fact list, not a progress view: there is no
 * progress bar.
 *
 * Each fact renders its own loading, success, and error state, so a failed pull request
 * or sessions read shows an inline message on that fact alone and never blanks the
 * others. The step and failure facts come straight from the selected run, which the list
 * already loaded. Time, tokens, and cost are computed from the sessions fact by the pure
 * integer helpers in `run-summary-totals.ts`; the token breakdown and the cost-unknown
 * reason appear in tooltips.
 */
import type { Run } from '@autocatalyst/api-contract';
import type { ReactNode } from 'react';

import { CELL_DASH } from './run-fields.js';
import type { PullRequestFact, SessionsFact } from './run-detail-facts.js';
import {
  computeSummaryTotals,
  formatCompactTokens,
  formatDurationMs,
  formatNanoUsd,
  formatTokenBreakdown
} from './run-summary-totals.js';
import { DescriptionItem, DescriptionList } from '../ui/description-list.js';
import { Tooltip } from '../ui/tooltip.js';

export interface RunDetailSummaryProps {
  readonly run: Run;
  readonly pullRequest: PullRequestFact;
  readonly sessions: SessionsFact;
}

/** The reason shown when at least one session has no priced cost. */
const COST_UNKNOWN_REASON = 'A model used in this run has no configured rate, so the cost is unknown.';

export function RunDetailSummary({ run, pullRequest, sessions }: RunDetailSummaryProps): ReactNode {
  return (
    <DescriptionList data-testid="pane-summary">
      {run.status === 'in_progress' ? (
        <DescriptionItem label="Step">
          <span data-testid="pane-summary-step" className="font-mono">
            {run.currentStep}
          </span>
        </DescriptionItem>
      ) : null}
      {run.status === 'failed' && run.failureReason !== undefined ? (
        <DescriptionItem label="Failure">
          <span data-testid="pane-summary-failure" className="text-red">
            {run.failureReason}
          </span>
        </DescriptionItem>
      ) : null}
      <DescriptionItem label="Pull request">{renderPullRequest(pullRequest)}</DescriptionItem>
      <DescriptionItem label="Time">{renderTime(sessions)}</DescriptionItem>
      <DescriptionItem label="Tokens">{renderTokens(sessions)}</DescriptionItem>
      <DescriptionItem label="Cost">{renderCost(sessions)}</DescriptionItem>
    </DescriptionList>
  );
}

function renderPullRequest(fact: PullRequestFact): ReactNode {
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
  return (
    <a
      data-testid="pane-summary-pr"
      href={pr.url}
      target="_blank"
      rel="noopener noreferrer"
      className="text-text hover:underline"
    >
      #{pr.number} · {pr.state}
    </a>
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
  const totals = computeSummaryTotals(fact.value);
  return (
    <span data-testid="pane-summary-time" className="tabular-nums">
      {totals.time.kind === 'dash' ? CELL_DASH : formatDurationMs(totals.time.ms)}
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
  const totals = computeSummaryTotals(fact.value);
  if (totals.tokens.kind === 'dash') {
    return <span data-testid="pane-summary-tokens" className="tabular-nums">{CELL_DASH}</span>;
  }
  return (
    <Tooltip label={formatTokenBreakdown(totals.tokens.breakdown)} delay={0}>
      <span data-testid="pane-summary-tokens" tabIndex={0} className="tabular-nums underline decoration-dotted">
        {formatCompactTokens(totals.tokens.total)}
      </span>
    </Tooltip>
  );
}

function renderCost(fact: SessionsFact): ReactNode {
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
  const totals = computeSummaryTotals(fact.value);
  if (totals.cost.kind === 'dash') {
    return <span data-testid="pane-summary-cost" className="tabular-nums">{CELL_DASH}</span>;
  }
  if (totals.cost.kind === 'unknown') {
    return (
      <Tooltip label={COST_UNKNOWN_REASON} delay={0}>
        <span data-testid="pane-summary-cost" tabIndex={0} className="underline decoration-dotted">
          Unknown
        </span>
      </Tooltip>
    );
  }
  return (
    <span data-testid="pane-summary-cost" className="tabular-nums">
      {formatNanoUsd(totals.cost.nanoUsd)}
    </span>
  );
}
