/**
 * RunDetailPane spec-gate integration: the pane-bar decision button and expand button, the footer
 * bridge (counts published while the Spec tab is active and cleared when the overlay opens), and the
 * single-SpecReview-instance rule when the expanded overlay is open.
 */
import type { FeedbackResponse, Run } from '@autocatalyst/api-contract';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { makeRun, makeSession } from './run-fixtures.js';
import { RunDetailFooterProvider, useRunDetailFooter } from './run-detail-footer.js';
import { RunDetailPane } from './run-detail-pane.js';
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

function renderGatePane(run: Run, feedbackList: FeedbackResponse[]) {
  const scripted = createScriptedDetailClient({ run });
  scripted.setPullRequest(null);
  scripted.setSessions([makeSession()]);
  scripted.setSpec('ready');
  scripted.setSpecMarkdown(SPEC_MD);
  scripted.setFeedback(feedbackList);
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
