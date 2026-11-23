/**
 * Summary fact tests: the header-owned Issue / Work kind / State rows are gone; Summary now
 * shows the step (in-progress only), the failure reason (failed only), and the pull request,
 * time, tokens, and cost facts, each with its own loading / success / error rendering, the
 * three cost cases, and the rule that one failed read never blanks the others.
 */
import type { SessionCostTotal } from '@autocatalyst/api-contract';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { makePullRequest, makeRun, makeSession } from './run-fixtures.js';
import { RunDetailSummary } from './run-detail-summary.js';
import type { PullRequestFact, SessionsFact } from './run-detail-facts.js';

const loadingPr: PullRequestFact = { status: 'loading' };
const noPr: PullRequestFact = { status: 'success', value: null };
const loadingSessions: SessionsFact = { status: 'loading' };

function sessionsOk(value: ReturnType<typeof makeSession>[], runCost?: SessionCostTotal): SessionsFact {
  return { status: 'success', value, ...(runCost === undefined ? {} : { runCost }) };
}

const priced: SessionCostTotal = {
  basis: 'api_list_price', knownSubtotalUsd: 300_000_001, complete: true,
  sessionCount: 2, pricedSessionCount: 2, unpricedSessionCount: 0, gaps: []
};

describe('RunDetailSummary', () => {
  it('renders every fact with no progress bar', () => {
    render(
      <RunDetailSummary
        run={makeRun({ workKind: 'feature', status: 'in_progress', waitingOn: 'human' })}
        pullRequest={noPr}
        sessions={sessionsOk([makeSession()])}
      />
    );
    expect(screen.getByTestId('pane-summary')).toBeDefined();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('never renders the header-owned Issue, Work kind, or State rows', () => {
    render(
      <RunDetailSummary
        run={makeRun({ workKind: 'feature', status: 'in_progress', waitingOn: 'human' })}
        pullRequest={noPr}
        sessions={sessionsOk([makeSession()])}
      />
    );
    expect(screen.queryByTestId('pane-summary-issue')).toBeNull();
    expect(screen.queryByTestId('pane-summary-state')).toBeNull();
    expect(screen.queryByText('Issue')).toBeNull();
    expect(screen.queryByText('Work kind')).toBeNull();
    expect(screen.queryByText('State')).toBeNull();
  });

  it('shows the current step in a monospace Step row only for an in-progress run', () => {
    const { rerender } = render(
      <RunDetailSummary
        run={{ ...makeRun({ status: 'in_progress', waitingOn: 'human' }), currentStep: 'spec.human_review' }}
        pullRequest={noPr}
        sessions={sessionsOk([makeSession()])}
      />
    );
    const step = screen.getByTestId('pane-summary-step');
    expect(step.textContent).toBe('spec.human_review');
    expect(step.className).toContain('font-mono');

    // A terminal run shows no Step row.
    rerender(
      <RunDetailSummary
        run={makeRun({ status: 'done', terminal: true })}
        pullRequest={noPr}
        sessions={sessionsOk([makeSession()])}
      />
    );
    expect(screen.queryByTestId('pane-summary-step')).toBeNull();
  });

  it('shows the failure reason in red only for a failed run with a reason', () => {
    const { rerender } = render(
      <RunDetailSummary
        run={{ ...makeRun({ status: 'failed', terminal: true }), failureReason: 'spec_author_failed' }}
        pullRequest={noPr}
        sessions={sessionsOk([makeSession()])}
      />
    );
    const failure = screen.getByTestId('pane-summary-failure');
    expect(failure.textContent).toBe('spec_author_failed');
    expect(failure.className).toContain('text-red');

    // An in-progress run shows no Failure row.
    rerender(
      <RunDetailSummary
        run={makeRun({ status: 'in_progress', waitingOn: 'human' })}
        pullRequest={noPr}
        sessions={sessionsOk([makeSession()])}
      />
    );
    expect(screen.queryByTestId('pane-summary-failure')).toBeNull();
  });

  it('links the pull request when one exists', () => {
    render(
      <RunDetailSummary
        run={makeRun()}
        pullRequest={{ status: 'success', value: makePullRequest({ number: 108, state: 'merged' }) }}
        sessions={sessionsOk([makeSession()])}
      />
    );
    const link = screen.getByTestId('pane-summary-pr');
    expect(link.textContent).toContain('#108');
    expect(link.textContent).toContain('Merged');
    expect(link.querySelector('span')?.className).toBe('text-green');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('shows a dash for no pull request and an inline error on failure', () => {
    const { rerender } = render(
      <RunDetailSummary run={makeRun()} pullRequest={noPr} sessions={sessionsOk([makeSession()])} />
    );
    expect(screen.getByTestId('pane-summary-pr').textContent).toBe('—');

    rerender(
      <RunDetailSummary
        run={makeRun()}
        pullRequest={{ status: 'error', message: 'Pull request read failed.' }}
        sessions={sessionsOk([makeSession()])}
      />
    );
    expect(screen.getByTestId('pane-summary-pr-error').textContent).toBe('Pull request read failed.');
  });

  it('does not blank other facts when the pull request read fails', () => {
    render(
      <RunDetailSummary
        run={makeRun({ workKind: 'feature' })}
        pullRequest={{ status: 'error', message: 'boom' }}
        sessions={sessionsOk([makeSession({ durationMs: 1000 })])}
      />
    );
    // The PR fact errored, but time/tokens/cost still render from the sessions fact.
    expect(screen.getByTestId('pane-summary-pr-error')).toBeDefined();
    expect(screen.getByTestId('pane-summary-time').textContent).toBe('1s');
    expect(screen.getByTestId('pane-summary-tokens')).toBeDefined();
    expect(screen.getByTestId('pane-summary-cost')).toBeDefined();
  });

  it('shows per-fact loading states', () => {
    render(<RunDetailSummary run={makeRun()} pullRequest={loadingPr} sessions={loadingSessions} />);
    expect(screen.getByTestId('pane-summary-pr').textContent).toBe('Loading…');
    expect(screen.getByTestId('pane-summary-time').textContent).toBe('Loading…');
    expect(screen.getByTestId('pane-summary-tokens').textContent).toBe('Loading…');
    expect(screen.getByTestId('pane-summary-cost').textContent).toBe('Loading…');
  });

  it('dashes time, tokens, and cost when there are no sessions', () => {
    render(<RunDetailSummary run={makeRun()} pullRequest={noPr} sessions={sessionsOk([])} />);
    expect(screen.getByTestId('pane-summary-time').textContent).toBe('—');
    expect(screen.getByTestId('pane-summary-tokens').textContent).toBe('—');
    expect(screen.getByTestId('pane-summary-cost').textContent).toBe('—');
  });

  it('renders the API amount instead of summing session costs', () => {
    render(
      <RunDetailSummary
        run={makeRun()}
        pullRequest={noPr}
        sessions={sessionsOk([
          makeSession({ id: 's1', usd: 100_000_000 }),
          makeSession({ id: 's2', usd: 100 })
        ], priced)}
      />
    );
    expect(screen.getByTestId('pane-summary-cost').textContent).toContain('$0.300000001');
  });

  it('distinguishes empty, unavailable, incomplete and estimated cost', async () => {
    const user = userEvent.setup();
    const run = makeRun({ status: 'in_progress' });
    const { rerender } = render(<RunDetailSummary run={run} pullRequest={noPr} sessions={sessionsOk([])} />);
    expect(screen.getByTestId('pane-summary-cost').getAttribute('aria-label')).toBe('No recorded sessions so far');
    const sessions = [makeSession()];
    rerender(<RunDetailSummary run={run} pullRequest={noPr} sessions={sessionsOk(sessions)} />);
    expect(screen.getByTestId('pane-summary-cost').textContent).toBe('Pricing unavailable so far');
    rerender(<RunDetailSummary run={run} pullRequest={noPr} sessions={sessionsOk(sessions, {
      ...priced, sessionCount: 1, pricedSessionCount: 0, unpricedSessionCount: 1, knownSubtotalUsd: null, complete: false
    })} />);
    expect(screen.getByTestId('pane-summary-cost').textContent).toBe('Unknown so far · API list price · Incomplete');
    rerender(<RunDetailSummary run={run} pullRequest={noPr} sessions={sessionsOk(sessions, {
      ...priced, sessionCount: 1, pricedSessionCount: 1, knownSubtotalUsd: 0, complete: false,
      gaps: [{ code: 'estimated_request_size', method: 'nearest_sample', tokenClass: 'freshInput', tokenCount: '50',
        provider: 'openai', model: 'served', hasUnknownTokenCount: false, sessionCount: 1 }]
    })} />);
    const cost = screen.getByTestId('pane-summary-cost');
    expect(cost.textContent).toBe('$0.00 so far · API list price · Incomplete · Includes estimates');
    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(cost);
    expect(await screen.findByText(/Long-context pricing band estimated.*50 tokens/)).toBeDefined();
  });

  it('reveals the token breakdown in a tooltip on hover', async () => {
    const user = userEvent.setup();
    render(
      <RunDetailSummary
        run={makeRun()}
        pullRequest={noPr}
        sessions={sessionsOk([makeSession({ tokens: { input: 1000, output: 50, cacheRead: 10, cacheWrite: 5 } })])}
      />
    );
    const tokens = screen.getByTestId('pane-summary-tokens');
    expect(tokens.textContent).toBe('1.1K · Legacy');
    await user.hover(tokens);
    expect(await screen.findByText(/Legacy: 1,065 tokens in 1 session/)).toBeDefined();
  });
});
