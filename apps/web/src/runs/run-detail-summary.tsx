/**
 * The Summary tab: a compact fact list — issue, work kind, state, pull request, time,
 * tokens, and cost. It is a fact list, not a progress view: there is no progress bar.
 *
 * Each fact renders its own loading, success, and error state, so a failed pull request
 * or sessions read shows an inline message on that fact alone and never blanks the
 * others. The run-derived facts (issue, work kind, state) come straight from the
 * selected run, which the list already loaded. Time, tokens, and cost are computed from
 * the sessions fact by the pure integer helpers in `run-summary-totals.ts`; the token
 * breakdown and the cost-unknown reason appear in tooltips.
 */
import type { Run } from '@autocatalyst/api-contract';
import type { ReactNode } from 'react';

import { CELL_DASH, rowTitle } from './run-fields.js';
import type { PullRequestFact, SessionsFact } from './run-detail-facts.js';
import {
  computeSummaryTotals,
  formatCompactTokens,
  formatDurationMs,
  formatNanoUsd,
  formatTokenBreakdown
} from './run-summary-totals.js';
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
    <dl data-testid="pane-summary" className="flex flex-col gap-3">
      <Fact label="Issue">{renderIssue(run)}</Fact>
      <Fact label="Work kind">
        <span>{run.workKind}</span>
      </Fact>
      <Fact label="State">{renderState(run)}</Fact>
      <Fact label="Pull request">{renderPullRequest(pullRequest)}</Fact>
      <Fact label="Time">{renderTime(sessions)}</Fact>
      <Fact label="Tokens">{renderTokens(sessions)}</Fact>
      <Fact label="Cost">{renderCost(sessions)}</Fact>
    </dl>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs font-medium text-subtext">{label}</dt>
      <dd className="text-base text-text">{children}</dd>
    </div>
  );
}

function renderIssue(run: Run): ReactNode {
  const title = rowTitle(run);
  if (run.trackedIssue !== undefined) {
    return (
      <a
        data-testid="pane-summary-issue"
        href={run.trackedIssue.url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-text hover:underline"
      >
        #{run.trackedIssue.number} {title.title}
      </a>
    );
  }
  return <span data-testid="pane-summary-issue">{run.id}</span>;
}

function renderState(run: Run): ReactNode {
  const statusLabel = STATUS_LABEL[run.status ?? 'unknown'] ?? CELL_DASH;
  const waiting = run.status === 'in_progress' ? waitingText(run.waitingOn) : undefined;
  return (
    <div data-testid="pane-summary-state" className="flex flex-col gap-0.5">
      <span>
        {statusLabel}
        {waiting !== undefined ? <span className="text-subtext"> · {waiting}</span> : null}
      </span>
      {run.status === 'in_progress' ? (
        <span className="font-mono text-xs text-subtext">{run.currentStep}</span>
      ) : null}
      {run.status === 'failed' && run.failureReason !== undefined ? (
        <span data-testid="pane-summary-failure" className="text-xs text-red">
          {run.failureReason}
        </span>
      ) : null}
    </div>
  );
}

const STATUS_LABEL: Readonly<Record<string, string>> = {
  in_progress: 'In progress',
  done: 'Done',
  failed: 'Failed',
  canceled: 'Canceled'
};

function waitingText(waitingOn: Run['waitingOn']): string | undefined {
  if (waitingOn === 'human') {
    return 'Waiting on you';
  }
  if (waitingOn === 'ai' || waitingOn === 'system') {
    return 'Working';
  }
  return undefined;
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
