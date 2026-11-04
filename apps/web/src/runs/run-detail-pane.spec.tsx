/**
 * RunDetailPane tests: the complementary region, the header, the four-tab model with
 * kept selection, the Summary facts, the empty states, and the no-run / run-gone states.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makePullRequest, makeRun, makeSession } from './run-fixtures.js';
import { RunDetailPane } from './run-detail-pane.js';
import { createScriptedDetailClient } from './scripted-detail-client.js';
import {
  ACCEPTANCE_EMPTY_STATE,
  ACTIVITY_EMPTY_STATE,
  SPEC_EMPTY_STATES
} from './run-detail-empty-states.js';

afterEach(() => {
  vi.useRealTimers();
});

function renderPane(run = makeRun({ id: 'run-1', workKind: 'feature' })) {
  const scripted = createScriptedDetailClient({ run });
  scripted.setPullRequest(null);
  scripted.setSessions([makeSession()]);
  scripted.setSpec('drafting');
  const replaceRun = vi.fn();
  const onUnauthorized = vi.fn();
  const utils = render(
    <RunDetailPane
      run={run}
      client={scripted.client}
      visible
      replaceRun={replaceRun}
      onUnauthorized={onUnauthorized}
    />
  );
  return { scripted, replaceRun, onUnauthorized, ...utils };
}

describe('RunDetailPane', () => {
  it('exposes a complementary region named "Run detail" carrying the selected run id', () => {
    renderPane(makeRun({ id: 'run-7' }));
    const region = screen.getByRole('complementary', { name: 'Run detail' });
    expect(region.getAttribute('data-pane-run-id')).toBe('run-7');
  });

  it('shows the header and the four tabs in order', () => {
    renderPane(makeRun({ id: 'run-1', issueTitle: 'Add the pane', workKind: 'feature' }));
    expect(screen.getByTestId('pane-run-title').textContent).toBe('Add the pane');
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Summary', 'Spec', 'Acceptance', 'Activity']);
  });

  it('shows the Summary facts on the default tab', async () => {
    renderPane();
    const summary = screen.getByTestId('pane-summary');
    await waitFor(() => expect(within(summary).getByTestId('pane-summary-pr').textContent).toBe('—'));
    expect(screen.getByRole('tab', { name: 'Summary' }).getAttribute('aria-selected')).toBe('true');
  });

  it('shows each non-Summary empty state when its tab is selected', async () => {
    const user = userEvent.setup();
    renderPane(makeRun({ workKind: 'feature' }));

    await user.click(screen.getByRole('tab', { name: 'Spec' }));
    await waitFor(() =>
      expect(screen.getByTestId('pane-spec-empty').textContent).toContain(SPEC_EMPTY_STATES.drafting.title)
    );

    await user.click(screen.getByRole('tab', { name: 'Acceptance' }));
    expect(screen.getByTestId('pane-acceptance-empty').textContent).toContain(ACCEPTANCE_EMPTY_STATE.title);

    await user.click(screen.getByRole('tab', { name: 'Activity' }));
    expect(screen.getByTestId('pane-activity-empty').textContent).toContain(ACTIVITY_EMPTY_STATE.title);
  });

  it('shows the spec no-spec empty state for a non-spec work kind without reading the spec', async () => {
    const scripted = createScriptedDetailClient({ run: makeRun({ id: 'b1', workKind: 'bug' }) });
    scripted.setPullRequest(makePullRequest({ number: 3 }));
    scripted.setSessions([makeSession()]);
    const user = userEvent.setup();
    render(
      <RunDetailPane
        run={makeRun({ id: 'b1', workKind: 'bug' })}
        client={scripted.client}
        visible
        replaceRun={vi.fn()}
        onUnauthorized={vi.fn()}
      />
    );
    await user.click(screen.getByRole('tab', { name: 'Spec' }));
    expect(screen.getByTestId('pane-spec-empty').textContent).toContain(SPEC_EMPTY_STATES.noSpec.title);
    // Let any read settle; the spec read must never have fired.
    await waitFor(() => expect(scripted.counts.getRun).toBe(1));
    expect(scripted.counts.spec).toBe(0);
  });

  it('keeps the selected tab when the selected run changes', async () => {
    const user = userEvent.setup();
    const scripted = createScriptedDetailClient({ run: makeRun({ id: 'run-1', workKind: 'feature' }) });
    scripted.setPullRequest(null);
    scripted.setSessions([makeSession()]);
    const { rerender } = render(
      <RunDetailPane
        run={makeRun({ id: 'run-1', workKind: 'feature' })}
        client={scripted.client}
        visible
        replaceRun={vi.fn()}
        onUnauthorized={vi.fn()}
      />
    );
    await user.click(screen.getByRole('tab', { name: 'Activity' }));
    expect(screen.getByRole('tab', { name: 'Activity' }).getAttribute('aria-selected')).toBe('true');

    // Selecting a different run keeps the pane mounted; the kept tab persists.
    rerender(
      <RunDetailPane
        run={makeRun({ id: 'run-2', workKind: 'enhancement' })}
        client={scripted.client}
        visible
        replaceRun={vi.fn()}
        onUnauthorized={vi.fn()}
      />
    );
    expect(screen.getByRole('tab', { name: 'Activity' }).getAttribute('aria-selected')).toBe('true');
  });

  it('shows the no-run state without a run', () => {
    const scripted = createScriptedDetailClient();
    render(
      <RunDetailPane run={undefined} client={scripted.client} visible replaceRun={vi.fn()} onUnauthorized={vi.fn()} />
    );
    expect(screen.getByTestId('pane-no-run')).toBeDefined();
    expect(screen.queryByRole('tab')).toBeNull();
  });

  it('renders every tab with content or an empty state for each scenario work kind', async () => {
    const user = userEvent.setup();
    for (const workKind of ['feature', 'enhancement', 'bug', 'chore'] as const) {
      const { unmount } = renderPane(makeRun({ id: `run-${workKind}`, workKind }));
      // Summary (default) has the fact list.
      await waitFor(() => expect(screen.getByTestId('pane-summary')).toBeDefined());
      await user.click(screen.getByRole('tab', { name: 'Spec' }));
      expect(screen.getByTestId('pane-spec-empty')).toBeDefined();
      await user.click(screen.getByRole('tab', { name: 'Acceptance' }));
      expect(screen.getByTestId('pane-acceptance-empty')).toBeDefined();
      await user.click(screen.getByRole('tab', { name: 'Activity' }));
      expect(screen.getByTestId('pane-activity-empty')).toBeDefined();
      unmount();
    }
  });
});
