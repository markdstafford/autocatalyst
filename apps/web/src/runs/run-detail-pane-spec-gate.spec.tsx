/**
 * RunDetailPane spec-gate integration: the pane-bar decision button and expand button, the footer
 * bridge (counts published while the Spec tab is active and cleared when the overlay opens), and the
 * single-SpecReview-instance rule when the expanded overlay is open.
 */
import type { FeedbackResponse, Run, RunStep } from '@autocatalyst/api-contract';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { makeRun, makeSession } from './run-fixtures.js';
import { RunDetailFooterProvider, useRunDetailFooter } from './run-detail-footer.js';
import { RunDetailHarness as RunDetailPane } from './run-detail-pane.test-helper.js';
import { createScriptedDetailClient } from './scripted-detail-client.js';

const NOW = '2026-11-08T01:00:00.000Z';
const SPEC_MD = '# Spec\n\nAlpha beta gamma delta epsilon zeta.';

function feedback(overrides: Partial<FeedbackResponse> & { id: string }): FeedbackResponse {
  return {
    id: overrides.id,
    runId: 'run-1',
    owner: { id: 'user-1', kind: 'human', tenantId: 'tenant-1', displayName: 'Phoebe' },
    tenant: 'tenant-1',
    target: 'artifact',
    status: 'open',
    title: 'Title',
    body: 'Body',
    thread: [{ id: `${overrides.id}-t`, author: { id: 'user-1', kind: 'human', tenantId: 'tenant-1' }, body: 'Body', createdAt: NOW }],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  } as FeedbackResponse;
}

function anchoredOpen(id: string, from: number, to: number): FeedbackResponse {
  return feedback({ id, anchor: { kind: 'artifact_range', artifactId: 'artifact-1', from, to, quotedText: 'x' } as FeedbackResponse['anchor'] });
}

function FooterProbe(): ReactNode {
  const { content } = useRunDetailFooter();
  return (
    <div data-testid="footer-probe">
      {content !== null ? `${content.openCount} open, ${content.resolvedCount} resolved` : 'none'}
    </div>
  );
}

function renderGatePane(run: Run, feedbackList: FeedbackResponse[], steps: RunStep[] = []) {
  const scripted = createScriptedDetailClient({ run });
  scripted.setPullRequest(null);
  scripted.setSessions([makeSession()]);
  scripted.setSpec('ready');
  scripted.setSpecMarkdown(SPEC_MD);
  scripted.setFeedback(feedbackList);
  scripted.setSteps(steps);
  render(
    <RunDetailFooterProvider>
      <RunDetailPane
        run={run}
        client={scripted.client}
        visible
        currentPrincipalId="user-1"
        replaceRun={vi.fn()}
        onUnauthorized={vi.fn()}
      />
      <FooterProbe />
    </RunDetailFooterProvider>
  );
  return scripted;
}

describe('RunDetailPane — spec gate', () => {
  it('shows bounded review and confirms a reason on eligible model findings without approving', async () => {
    const user = userEvent.setup();
    const model = { id: 'anthropic:reviewer', kind: 'model' as const, tenantId: 'tenant-1' };
    const item = feedback({ id: 'model-1', thread: [{ id: 't1', author: model, body: 'Concern', createdAt: NOW }] });
    const steps: RunStep[] = [
      { id: 'author', runId: 'run-1', phase: 'spec', step: 'spec.author', role: 'none',
        startedAt: NOW, endedAt: NOW, durationMs: 0, occurrence: { index: 1, attempt: 1 },
        checkpointResult: { producingStep: 'spec.author', outcome: 'max_rounds', openFeedbackIds: [item.id] } },
      { id: 'gate', runId: 'run-1', phase: 'spec', step: 'spec.human_review', role: 'none',
        startedAt: NOW, endedAt: null, durationMs: null, occurrence: { index: 2, attempt: 1 }, checkpointResult: null }
    ];
    const scripted = renderGatePane(makeRun({ id: 'run-1', workKind: 'feature' }), [item], steps);
    await user.click(screen.getByRole('tab', { name: 'Spec' }));
    expect(await screen.findByText(/Automated spec review did not converge/u)).toBeDefined();
    await user.click(await screen.findByRole('button', { name: 'Decline finding' }));
    const confirm = screen.getByRole('button', { name: 'Confirm decline' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await user.type(screen.getByLabelText('Decline reason'), 'Accept the current scope.');
    await user.click(confirm);
    await waitFor(() => expect(screen.getByTestId('status-chip').textContent).toBe('wont_fix'));
    expect(scripted.feedbackUpdateCalls).toEqual([{ feedbackId: item.id,
      request: { status: 'wont_fix', body: 'Accept the current scope.' } }]);
    expect(scripted.replyCalls).toEqual([]);
    expect(screen.getByTestId('spec-gate-decision').textContent).toBe('Approve');
  });

  it('shows the decision label in the pane bar for a spec-gate run', async () => {
    renderGatePane(makeRun({ id: 'run-1', workKind: 'feature' }), [anchoredOpen('c1', 9, 14)]);
    await waitFor(() => expect(screen.getByTestId('spec-gate-decision').textContent).toBe('Request changes (1)'));
  });

  it('publishes the footer counts while the Spec tab is active and clears them when the overlay opens', async () => {
    const user = userEvent.setup();
    renderGatePane(makeRun({ id: 'run-1', workKind: 'feature' }), [anchoredOpen('c1', 9, 14)]);
    await waitFor(() => expect(screen.getByTestId('spec-gate-decision')).toBeDefined());

    // Summary tab is active by default: no footer counts yet.
    expect(screen.getByTestId('footer-probe').textContent).toBe('none');

    await user.click(screen.getByRole('tab', { name: 'Spec' }));
    await waitFor(() => expect(screen.getByTestId('footer-probe').textContent).toBe('1 open, 0 resolved'));

    // The expand button is present on the Spec tab; opening the overlay clears the footer bridge.
    await user.click(screen.getByTestId('spec-expand'));
    await waitFor(() => expect(screen.getByTestId('spec-overlay')).toBeDefined());
    expect(screen.getByTestId('footer-probe').textContent).toBe('none');
  });

  it('mounts only one SpecReview (document) when the overlay is open', async () => {
    const user = userEvent.setup();
    renderGatePane(makeRun({ id: 'run-1', workKind: 'feature' }), [anchoredOpen('c1', 9, 14)]);
    await user.click(await screen.findByRole('tab', { name: 'Spec' }));
    await waitFor(() => expect(screen.getAllByTestId('spec-document').length).toBe(1));
    await user.click(screen.getByTestId('spec-expand'));
    await waitFor(() => expect(screen.getByTestId('pane-spec-expanded')).toBeDefined());
    // The pane SpecReview is unmounted; only the overlay's document remains.
    expect(screen.getAllByTestId('spec-document').length).toBe(1);
  });

  it('shows no decision or expand button when the spec is not ready', async () => {
    const scripted = createScriptedDetailClient({ run: makeRun({ id: 'run-1', workKind: 'feature' }) });
    scripted.setPullRequest(null);
    scripted.setSessions([makeSession()]);
    scripted.setSpec('drafting');
    render(
      <RunDetailFooterProvider>
        <RunDetailPane run={makeRun({ id: 'run-1', workKind: 'feature' })} client={scripted.client} visible currentPrincipalId="user-1" replaceRun={vi.fn()} onUnauthorized={vi.fn()} />
      </RunDetailFooterProvider>
    );
    await waitFor(() => expect(scripted.counts.spec).toBeGreaterThanOrEqual(1));
    expect(screen.queryByTestId('spec-gate-decision')).toBeNull();
    expect(screen.queryByTestId('spec-expand')).toBeNull();
  });

  it('shows the overlay comment counts and a working decision button in the overlay', async () => {
    const user = userEvent.setup();
    renderGatePane(makeRun({ id: 'run-1', workKind: 'feature' }), [anchoredOpen('c1', 9, 14)]);
    await user.click(await screen.findByRole('tab', { name: 'Spec' }));
    await user.click(screen.getByTestId('spec-expand'));
    const overlay = await screen.findByTestId('spec-overlay');
    expect(within(overlay).getByTestId('spec-comment-counts').textContent).toBe('1 open, 0 resolved');
    expect(within(overlay).getByTestId('spec-gate-decision').textContent).toBe('Request changes (1)');
  });
});
