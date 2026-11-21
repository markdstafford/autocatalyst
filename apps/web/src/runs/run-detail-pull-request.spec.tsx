import type { PullRequestCheckFailureReason, Run } from '@autocatalyst/api-contract';
import { ControlPlaneClientError } from '@autocatalyst/sdk';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { expect, it, vi } from 'vitest';

import { RunDetailHarness } from './run-detail-pane.test-helper.js';
import { makePullRequest, makeRun } from './run-fixtures.js';
import { isStrictlyNewer } from './run-row-merge.js';
import { createScriptedDetailClient, serverError } from './scripted-detail-client.js';
import { useRunDetail } from './use-run-detail.js';

const review: Run = { ...makeRun(), currentStep: 'pr.human_review' };
const open = makePullRequest();
const done: Run = {
  ...review, updatedAt: '2026-01-01T00:00:02.000Z', currentStep: 'done',
  waitingOn: 'none', status: 'done', terminal: true
};
const failed: Run = {
  ...done, currentStep: 'failed', status: 'failed', failureReason: 'pull_request_closed_without_merge'
};

function deferred<T>() {
  let resolve!: (result: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { resolve, promise };
}

function setup(run = review, pr = open) {
  const scripted = createScriptedDetailClient({ run });
  scripted.setPullRequest(pr);
  const check = vi.spyOn(scripted.client, 'refreshRunPullRequest').mockResolvedValue({ pullRequest: pr, run });
  return { ...scripted, check };
}

function renderPane(run: Run, { client }: ReturnType<typeof setup>) {
  function Pane() {
    const [row, setRow] = useState(run);
    return (
      <RunDetailHarness
        run={row}
        client={client}
        visible
        replaceRun={(fresh) => setRow((last) => isStrictlyNewer(fresh, last) ? fresh : last)}
        onUnauthorized={vi.fn()}
      />
    );
  }
  return render(<Pane />);
}

async function expectOpenCheck() {
  await screen.findByText('Checked just now');
  expect(screen.getByTestId('pane-summary-pr').textContent).toContain('Open');
  expect(screen.getByRole('button', { name: 'Check now' }).getAttribute('aria-disabled')).not.toBe('true');
}

it.each([
  failed, done,
  { ...review, status: 'canceled' },
  { ...review, currentStep: 'pr.finalize' },
  { ...review, waitingOn: undefined },
  { ...review, waitingOn: 'system' }
] satisfies Run[])('does not check a stored open PR for $status/$currentStep/$waitingOn', async (run) => {
  const scripted = setup(run);
  renderPane(run, scripted);
  await screen.findByText('Open');
  expect(screen.queryByRole('button', { name: 'Check now' })).toBeNull();
  expect(screen.getByRole('status').textContent).toBe('');
  expect(scripted.check).not.toHaveBeenCalled();
});

it.each([
  { state: 'merged', result: done, label: 'Merged', chip: 'Done' },
  { state: 'closed', result: failed, label: 'Closed', chip: 'Failed' }
] as const)('checks a stored $state PR when the run still needs repair', async ({ state, result, label, chip }) => {
  const pullRequest = makePullRequest({ state });
  const scripted = setup(review, pullRequest);
  scripted.check.mockResolvedValue({ pullRequest, run: result });
  renderPane(review, scripted);
  await screen.findByText(chip);
  expect(screen.getByTestId('pane-summary-pr').textContent).toContain(label);
  expect(screen.queryByRole('button', { name: 'Check now' })).toBeNull();
  expect(scripted.check).toHaveBeenCalledExactlyOnceWith(review.id);
  if (state === 'closed') {
    expect(screen.getByTestId('pane-summary-failure').textContent).toBe('The pull request was closed without merging.');
  }
});

it('keeps Check now after a repair error, then removes it after successful manual repair', async () => {
  const user = userEvent.setup();
  const pullRequest = makePullRequest({ state: 'closed' });
  const scripted = setup(review, pullRequest);
  scripted.check.mockRejectedValueOnce(serverError()).mockResolvedValue({ pullRequest, run: failed });
  renderPane(review, scripted);
  await screen.findByText('Could not check the pull request.');
  expect(screen.getByTestId('pane-summary-pr').textContent).toContain('Closed');
  expect(screen.queryByText('Failed')).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Check now' }));
  await screen.findByText('Failed');
  expect(screen.queryByRole('button', { name: 'Check now' })).toBeNull();
  expect(scripted.check).toHaveBeenCalledTimes(2);
});

it.each([
  ['credential_missing', "The code host credential is missing. Update it in this project's settings."],
  ['authentication_failed', "The code host rejected the credential. Update it in this project's settings."],
  ['not_found', 'The pull request was not found.'],
  ['provider_unavailable', 'The code host could not be reached.'],
  ['unexpected', 'Could not check the pull request.']
] satisfies [PullRequestCheckFailureReason | 'unexpected', string][])('shows safe inline copy for %s', async (reason, message) => {
  const scripted = setup();
  scripted.check.mockRejectedValue(reason === 'unexpected'
    ? new Error('secret')
    : new ControlPlaneClientError(502, {
      error: { code: 'pull_request_check_failed', message: 'secret', details: { reason, provider: 'secret' } }
    }));
  renderPane(review, scripted);
  await screen.findByText(message);
  expect(screen.getByRole('status').textContent).toBe(message);
  expect(screen.getByTestId('pane-summary-pr').getAttribute('href')).toBe(open.url);
  expect(screen.getByTestId('pane-summary-pr').textContent).toContain('Open');
  expect(screen.getByText('Needs review')).toBeDefined();
  expect(screen.getByRole('button', { name: 'Check now' }).getAttribute('aria-disabled')).not.toBe('true');
});

it('keeps the previous checked time and facts on a manual conflict after a gate race', async () => {
  const user = userEvent.setup();
  const scripted = setup();
  renderPane(review, scripted);
  await expectOpenCheck();
  const checkedAt = screen.getByRole('status').querySelector('time')?.dateTime;
  expect(checkedAt).toBeTruthy();
  scripted.check.mockRejectedValueOnce(new ControlPlaneClientError(409, {
    error: { code: 'conflict', message: 'The run is no longer eligible for a pull request check.' }
  }));
  await user.click(screen.getByRole('button', { name: 'Check now' }));
  await screen.findByText('The run is no longer eligible for a pull request check.');
  expect(screen.getByRole('status').querySelector('time')?.dateTime).toBe(checkedAt);
  expect(screen.getByTestId('pane-summary-pr').textContent).toContain('Open');
  expect(screen.getByText('Needs review')).toBeDefined();
  expect(scripted.check).toHaveBeenCalledTimes(2);
});

it('shares a single in-flight check and does not recheck on a pane toggle or transition read', async () => {
  const scripted = setup();
  const pending = deferred<{ run: Run; pullRequest: typeof open }>();
  scripted.check.mockReturnValueOnce(pending.promise);
  const { result, rerender } = renderHook(
    ({ visible }) => useRunDetail({ ...scripted, run: review, visible, replaceRun: vi.fn(), onUnauthorized: vi.fn() }),
    { initialProps: { visible: true } }
  );
  await waitFor(() => expect(result.current.pullRequestCheck.pending).toBe(true));
  act(() => result.current.checkPullRequest?.());
  rerender({ visible: false });
  rerender({ visible: true });
  act(() => scripted.latestStream()?.pushTransition({ id: 'event' }));
  await act(async () => pending.resolve({ run: review, pullRequest: open }));
  await waitFor(() => expect(scripted.counts.pullRequest).toBeGreaterThan(1));
  expect(scripted.check).toHaveBeenCalledTimes(1);
  act(() => {
    result.current.checkPullRequest?.();
    result.current.checkPullRequest?.();
  });
  await waitFor(() => expect(result.current.pullRequestCheck.checkedAt).toBeDefined());
  expect(scripted.check).toHaveBeenCalledTimes(2);
});

it('shows Checking, retaining the link and disabling the action while the check is in flight', async () => {
  const user = userEvent.setup();
  const scripted = setup();
  renderPane(review, scripted);
  await expectOpenCheck();
  const pending = deferred<{ run: Run; pullRequest: typeof open }>();
  scripted.check.mockReturnValueOnce(pending.promise);
  const action = screen.getByRole('button', { name: 'Check now' });
  await user.click(action);
  await screen.findByText('Checking');
  expect(screen.getByRole('status').querySelector('svg')).not.toBeNull();
  expect(screen.getByTestId('pane-summary-pr').getAttribute('href')).toBe(open.url);
  expect(action.getAttribute('aria-disabled')).toBe('true');
  expect(document.activeElement).toBe(action);
  await user.click(action);
  expect(scripted.check).toHaveBeenCalledTimes(2);
  await act(async () => pending.resolve({ run: review, pullRequest: open }));
  await expectOpenCheck();
});

it('ignores an older detail read finishing after a check succeeds', async () => {
  const scripted = setup();
  const laterRead = deferred<{ pullRequest: typeof open }>();
  const replaceRun = vi.fn();
  const { result } = renderHook(() => useRunDetail({
    ...scripted, run: review, visible: true, replaceRun, onUnauthorized: vi.fn()
  }));
  await waitFor(() => expect(result.current.pullRequestCheck.checkedAt).toBeDefined());
  const read = vi.spyOn(scripted.client, 'getRunPullRequest').mockReturnValueOnce(laterRead.promise);
  act(() => scripted.latestStream()?.pushTransition({ id: 'transition' }));
  await waitFor(() => expect(read).toHaveBeenCalled());
  const merged = { ...open, state: 'merged', updatedAt: done.updatedAt } as const;
  scripted.check.mockResolvedValueOnce({ run: done, pullRequest: merged });
  await act(async () => result.current.checkPullRequest?.());
  expect(result.current.pullRequest).toEqual({ status: 'success', value: merged });
  expect(replaceRun).toHaveBeenLastCalledWith(done);
  await act(async () => laterRead.resolve({ pullRequest: open }));
  expect(result.current.pullRequest).toEqual({ status: 'success', value: merged });
  expect(result.current.checkPullRequest).toBeUndefined();
});

it('discards an earlier check across A → B → A, including run replacement and transient state', async () => {
  const scripted = setup();
  const pending = deferred<{ run: Run; pullRequest: typeof open }>();
  scripted.check.mockReturnValueOnce(pending.promise);
  const replaceRun = vi.fn();
  const { result, rerender } = renderHook(
    ({ run }) => useRunDetail({ ...scripted, run, visible: true, replaceRun, onUnauthorized: vi.fn() }),
    { initialProps: { run: review } }
  );
  await waitFor(() => expect(scripted.check).toHaveBeenCalledTimes(1));
  const other = { ...makeRun({ id: 'other' }), currentStep: 'pr.finalize' };
  scripted.setRun(other);
  scripted.setPullRequest(makePullRequest({ runId: other.id }));
  rerender({ run: other });
  await waitFor(() => expect(result.current.checkPullRequest).toBeUndefined());
  scripted.setRun(review);
  scripted.setPullRequest(open);
  rerender({ run: review });
  await waitFor(() => expect(result.current.pullRequestCheck.checkedAt).toBeDefined());
  const time = result.current.pullRequestCheck.checkedAt;
  await act(async () => pending.resolve({ run: done, pullRequest: { ...open, state: 'merged', updatedAt: done.updatedAt } }));
  expect(result.current.pullRequest).toEqual({ status: 'success', value: open });
  expect(result.current.pullRequestCheck.checkedAt).toBe(time);
  expect(replaceRun).not.toHaveBeenCalledWith(done);
  expect(scripted.check).toHaveBeenCalledTimes(2);
});

it('ignores a check of a replaced stored pull request', async () => {
  const scripted = setup();
  const pending = deferred<{ run: Run; pullRequest: typeof open }>();
  scripted.check.mockReturnValueOnce(pending.promise);
  const replaceRun = vi.fn();
  const { result } = renderHook(() => useRunDetail({
    ...scripted, run: review, visible: true, replaceRun, onUnauthorized: vi.fn()
  }));
  await waitFor(() => expect(result.current.pullRequestCheck.pending).toBe(true));

  const replacement = makePullRequest({ number: 500 });
  scripted.setPullRequest(replacement);
  act(() => scripted.latestStream()?.pushTransition({ id: 'change' }));
  await waitFor(() => expect(result.current.pullRequest).toEqual({ status: 'success', value: replacement }));
  await act(async () => pending.resolve({ run: done, pullRequest: { ...open, state: 'merged', updatedAt: done.updatedAt } }));
  expect(result.current.pullRequest).toEqual({ status: 'success', value: replacement });
  expect(result.current.pullRequestCheck).toEqual({});
  expect(replaceRun).not.toHaveBeenCalledWith(done);
});

it('rechecks the latest run projection before dispatching a manual check', async () => {
  const scripted = setup();
  const { result, rerender } = renderHook(
    ({ run }) => useRunDetail({ ...scripted, run, visible: true, replaceRun: vi.fn(), onUnauthorized: vi.fn() }),
    { initialProps: { run: review } }
  );
  await waitFor(() => expect(result.current.pullRequestCheck.checkedAt).toBeDefined());
  const click = result.current.checkPullRequest;
  rerender({ run: done });
  expect(result.current.checkPullRequest).toBeUndefined();
  act(() => click?.());
  expect(scripted.check).toHaveBeenCalledTimes(1);
});

it.each(['missing pull request', 'unreadable run'])('does not rearm after an initial %s', async (missing) => {
  const scripted = setup();
  if (missing === 'missing pull request') {
    scripted.setPullRequest(null);
  } else {
    scripted.setRunError(serverError());
  }
  const { result } = renderHook(() => useRunDetail({
    ...scripted, run: review, visible: true, replaceRun: vi.fn(), onUnauthorized: vi.fn()
  }));
  await waitFor(() => expect(result.current.pullRequest.status).toBe('success'));
  expect(result.current.checkPullRequest).toBeUndefined();
  scripted.setRun(review);
  scripted.setPullRequest(open);
  act(() => scripted.latestStream()?.pushTransition({ id: 'later' }));
  await waitFor(() => expect(result.current.checkPullRequest).toBeDefined());
  expect(scripted.check).not.toHaveBeenCalled();
});

it('does not automatically check a PR opened by this selection’s approval before its reads settle', async () => {
  const implementation: Run = { ...review, currentStep: 'implementation.human_review' };
  const scripted = setup(implementation);
  scripted.hold();
  const { result, rerender } = renderHook(
    ({ run }) => useRunDetail({ ...scripted, run, visible: true, replaceRun: vi.fn(), onUnauthorized: vi.fn() }),
    { initialProps: { run: implementation } }
  );
  await waitFor(() => expect(scripted.counts.getRun).toBe(1));
  let approval: ReturnType<typeof result.current.replyToGate>;
  act(() => { approval = result.current.replyToGate('approve'); });
  const transitioned = { ...review, updatedAt: done.updatedAt };
  scripted.setRun(transitioned);
  rerender({ run: transitioned });
  await act(async () => {
    scripted.release();
    await approval;
  });
  await waitFor(() => expect(result.current.checkPullRequest).toBeDefined());
  expect(scripted.check).not.toHaveBeenCalled();
});
