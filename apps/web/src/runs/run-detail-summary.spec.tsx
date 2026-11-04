/**
 * Summary fact tests: every fact's loading / success / error rendering, the three cost
 * cases, the failure reason, the pull request states, and that one failed read does not
 * blank the others.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { makePullRequest, makeRun, makeSession } from './run-fixtures.js';
import { RunDetailSummary } from './run-detail-summary.js';
import type { PullRequestFact, SessionsFact } from './run-detail-facts.js';

const loadingPr: PullRequestFact = { status: 'loading' };
const noPr: PullRequestFact = { status: 'success', value: null };
const loadingSessions: SessionsFact = { status: 'loading' };

function sessionsOk(value: ReturnType<typeof makeSession>[]): SessionsFact {
  return { status: 'success', value };
}

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

  it('shows the in-progress state with waiting text and current step', () => {
    render(
      <RunDetailSummary
        run={{ ...makeRun({ status: 'in_progress', waitingOn: 'human' }), currentStep: 'spec.human_review' }}
        pullRequest={noPr}
        sessions={sessionsOk([makeSession()])}
      />
    );
    const state = screen.getByTestId('pane-summary-state');
    expect(state.textContent).toContain('In progress');
    expect(state.textContent).toContain('Waiting on you');
    expect(state.textContent).toContain('spec.human_review');
  });

  it('shows the failure reason for a failed run', () => {
    render(
      <RunDetailSummary
        run={{ ...makeRun({ status: 'failed', terminal: true }), failureReason: 'spec_author_failed' }}
        pullRequest={noPr}
        sessions={sessionsOk([makeSession()])}
      />
    );
    expect(screen.getByTestId('pane-summary-failure').textContent).toBe('spec_author_failed');
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
    expect(link.textContent).toContain('merged');
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

  it('sums priced cost and shows a dollar amount', () => {
    render(
      <RunDetailSummary
        run={makeRun()}
        pullRequest={noPr}
        sessions={sessionsOk([
          makeSession({ id: 's1', usd: 100_000_000 }),
          makeSession({ id: 's2', usd: 200_000_000 })
        ])}
      />
    );
    expect(screen.getByTestId('pane-summary-cost').textContent).toBe('$0.30');
  });

  it('shows Unknown cost when a session is unpriced', () => {
    render(
      <RunDetailSummary
        run={makeRun()}
        pullRequest={noPr}
        sessions={sessionsOk([makeSession({ id: 's1', usd: 100_000_000 }), makeSession({ id: 's2', usd: null })])}
      />
    );
    expect(screen.getByTestId('pane-summary-cost').textContent).toBe('Unknown');
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
    expect(tokens.textContent).toBe('1.1K');
    await user.hover(tokens);
    expect(await screen.findByText('Input 1,000 · Output 50 · Cache read 10 · Cache write 5')).toBeDefined();
  });
});
