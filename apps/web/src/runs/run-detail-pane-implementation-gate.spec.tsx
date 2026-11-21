import type { Run } from '@autocatalyst/api-contract';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';

import { ACCEPTANCE_EMPTY_STATE } from './run-detail-empty-states.js';
import { RunDetailHarness } from './run-detail-pane.test-helper.js';
import { makeRun } from './run-fixtures.js';
import { createScriptedDetailClient, serverError } from './scripted-detail-client.js';

const implementation: Run = { ...makeRun(), currentStep: 'implementation.human_review' };
const decisionId = 'implementation-gate-decision';

function setup(run = implementation) {
  const scripted = createScriptedDetailClient({ run });
  const createFeedback = vi.spyOn(scripted.client, 'createRunFeedback');
  const pane = (selected: Run) => (
    <RunDetailHarness
      run={selected} client={scripted.client} visible replaceRun={vi.fn()} onUnauthorized={vi.fn()}
    />
  );
  const view = render(pane(run));
  return { ...scripted, createFeedback, select: (selected: Run) => view.rerender(pane(selected)) };
}

it('offers only one approve action on any tab without a loaded spec, and cancel sends nothing', async () => {
  const user = userEvent.setup();
  const scripted = setup();
  const approve = screen.getByTestId(decisionId);
  for (const name of ['Spec', 'Activity', 'Acceptance', 'Summary']) {
    await user.click(screen.getByRole('tab', { name }));
    expect(within(screen.getByTestId('pane-bar')).getAllByRole('button')).toEqual([approve]);
    expect(approve.textContent).toBe('Approve');
    if (name === 'Acceptance') {
      expect(screen.getByText(ACCEPTANCE_EMPTY_STATE.title)).toBeDefined();
    }
  }

  await user.click(approve);
  const dialog = await screen.findByRole('dialog', { name: 'Approve this implementation?' });
  expect(within(dialog).queryByTestId(`${decisionId}-copy`)).toBeNull();
  await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(scripted.replyCalls).toEqual([]);
  expect(scripted.createFeedback).not.toHaveBeenCalled();
});

it('sends only approve, disables duplicate submission, and shows errors in its popover', async () => {
  const user = userEvent.setup();
  const scripted = setup();
  await user.click(screen.getByTestId(decisionId));
  const confirm = await screen.findByTestId(`${decisionId}-confirm`);
  scripted.hold();
  scripted.setReplyError(serverError());
  await user.click(confirm);
  expect(confirm).toHaveProperty('disabled', true);
  expect(screen.getByTestId(decisionId)).toHaveProperty('disabled', true);
  await user.click(confirm);
  expect(scripted.replyCalls).toEqual([{ kind: 'approve' }]);
  expect(scripted.createFeedback).not.toHaveBeenCalled();

  await act(async () => scripted.release());
  expect((await screen.findByTestId(`${decisionId}-error`)).textContent).toBe('Boom.');
  scripted.setReplyError(undefined);
  await user.click(screen.getByRole('button', { name: 'Try again' }));
  expect(scripted.replyCalls).toEqual([{ kind: 'approve' }, { kind: 'approve' }]);
  expect(scripted.createFeedback).not.toHaveBeenCalled();
});

it('supports Enter to confirm the keyboard-opened decision', async () => {
  const user = userEvent.setup();
  const scripted = setup();
  screen.getByTestId(decisionId).focus();
  await user.keyboard('{Enter}');
  const confirm = await screen.findByTestId(`${decisionId}-confirm`);
  await waitFor(() => expect(document.activeElement).toBe(confirm));
  await user.keyboard('{Enter}');
  expect(scripted.replyCalls).toEqual([{ kind: 'approve' }]);
});

it('resets confirmation when selecting another run or leaving the gate', async () => {
  const user = userEvent.setup();
  const scripted = setup();
  await user.click(screen.getByTestId(decisionId));
  await screen.findByRole('dialog', { name: 'Approve this implementation?' });
  const other = { ...implementation, id: 'other' };
  scripted.select(other);
  expect(screen.queryByRole('dialog', { name: 'Approve this implementation?' })).toBeNull();
  expect(screen.getByTestId(decisionId)).toBeDefined();
  scripted.select({ ...other, currentStep: 'pr.human_review' });
  expect(screen.queryByTestId(decisionId)).toBeNull();
  expect(scripted.replyCalls).toEqual([]);
});

it.each([
  { ...implementation, terminal: true },
  { ...implementation, status: 'canceled' },
  { ...implementation, waitingOn: 'ai' }
] satisfies Run[])('does not offer approval when the run is not live and human-waiting', (run) => {
  setup(run);
  expect(screen.queryByTestId(decisionId)).toBeNull();
});

it('supports a legacy run with omitted waiting and status fields', () => {
  setup({ ...implementation, waitingOn: undefined, status: undefined });
  expect(screen.getByTestId(decisionId)).toBeDefined();
});
