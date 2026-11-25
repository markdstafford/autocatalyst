/**
 * Detail-pane data-hook tests with a scripted SDK client: stream-first initial reads,
 * a transition delivered between attach and initial-read completion, coalesced
 * refreshes, selection/hide/unmount aborts, reread-not-copied status, spec flip across a
 * transition, reconnect backoff + resume id, 409 cursor-loss recovery, 401, 404, and
 * terminal-stream stop behavior.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { assistant, at, attempt, workflow } from './run-activity.test-helper.js';
import { makeRun, makeSession, makeTransitionEvent } from './run-fixtures.js';
import {
  createScriptedDetailClient,
  cursorExpiredError,
  notFoundError,
  serverError,
  unauthorizedError
} from './scripted-detail-client.js';
import { useRunDetail, type UseRunDetailOptions } from './use-run-detail.js';

afterEach(() => {
  vi.useRealTimers();
});

interface HarnessOverrides {
  readonly client: UseRunDetailOptions['client'];
  readonly run?: UseRunDetailOptions['run'];
  readonly visible?: boolean;
  readonly replaceRun?: UseRunDetailOptions['replaceRun'];
  readonly onUnauthorized?: UseRunDetailOptions['onUnauthorized'];
  readonly reconnectDelayMs?: number;
  readonly reconnectMaxDelayMs?: number;
}

function props(overrides: HarnessOverrides): UseRunDetailOptions {
  return {
    client: overrides.client,
    run: overrides.run ?? makeRun(),
    visible: overrides.visible ?? true,
    replaceRun: overrides.replaceRun ?? vi.fn(),
    onUnauthorized: overrides.onUnauthorized ?? vi.fn(),
    ...(overrides.reconnectDelayMs !== undefined ? { reconnectDelayMs: overrides.reconnectDelayMs } : {}),
    ...(overrides.reconnectMaxDelayMs !== undefined ? { reconnectMaxDelayMs: overrides.reconnectMaxDelayMs } : {})
  };
}

describe('useRunDetail stream-first initial reads', () => {
  it('opens one stream before the initial reads and loads every fact', async () => {
    const scripted = createScriptedDetailClient({ run: makeRun({ id: 'r1', workKind: 'feature' }) });
    scripted.setPullRequest(null);
    scripted.setSessions([makeSession()]);
    scripted.setSpec('drafting');
    const replaceRun = vi.fn();
    const { result } = renderHook((p: UseRunDetailOptions) => useRunDetail(p), {
      initialProps: props({ client: scripted.client, run: makeRun({ id: 'r1', workKind: 'feature' }), replaceRun })
    });

    await waitFor(() => expect(scripted.counts.getRun).toBe(1));
    // The stream attached before the first read.
    expect(scripted.counts.subscribe).toBe(1);
    await waitFor(() => expect(result.current.pullRequest.status).toBe('success'));
    expect(scripted.counts.pullRequest).toBe(1);
    expect(scripted.counts.sessions).toBe(1);
    expect(scripted.counts.spec).toBe(1);
    expect(result.current.sessions.status).toBe('success');
    expect(result.current.spec.status).toBe('drafting');
    expect(replaceRun).toHaveBeenCalledTimes(1);
  });

  it('skips the spec read for a non-spec work kind', async () => {
    const scripted = createScriptedDetailClient({ run: makeRun({ id: 'r1', workKind: 'bug' }) });
    const { result } = renderHook((p: UseRunDetailOptions) => useRunDetail(p), {
      initialProps: props({ client: scripted.client, run: makeRun({ id: 'r1', workKind: 'bug' }) })
    });
    await waitFor(() => expect(scripted.counts.getRun).toBe(1));
    expect(result.current.spec.status).toBe('no-spec');
    expect(scripted.counts.spec).toBe(0);
  });
});

describe('useRunDetail transition refresh and coalescing', () => {
  it('ends on the newest reread run when a transition lands during the initial reads', async () => {
    const v1 = makeRun({ id: 'r1', workKind: 'feature' });
    const scripted = createScriptedDetailClient({ run: v1 });
    const replaceRun = vi.fn();
    scripted.hold(); // keep the initial reads in flight
    renderHook((p: UseRunDetailOptions) => useRunDetail(p), {
      initialProps: props({ client: scripted.client, run: v1, replaceRun })
    });
    await waitFor(() => expect(scripted.latestStream()).toBeDefined());
    // A transition arrives while the initial refresh is still in flight.
    const v2 = { ...v1, currentStep: 'spec.human_review', updatedAt: '2026-01-02T00:00:00.000Z' };
    scripted.setRun(v2);
    await act(async () => {
      scripted.latestStream()?.pushTransition({ id: 'e1' });
      await Promise.resolve();
    });
    await act(async () => {
      scripted.release();
    });
    // Exactly two refreshes: the in-flight one plus one coalesced trailing refresh.
    await waitFor(() => expect(scripted.counts.getRun).toBe(2));
    const lastArg = replaceRun.mock.calls[replaceRun.mock.calls.length - 1]?.[0];
    expect(lastArg?.currentStep).toBe('spec.human_review');
  });

  it('coalesces three quick transitions into at most two refreshes', async () => {
    const scripted = createScriptedDetailClient({ run: makeRun({ id: 'r1', workKind: 'feature' }) });
    scripted.hold();
    renderHook((p: UseRunDetailOptions) => useRunDetail(p), {
      initialProps: props({ client: scripted.client, run: makeRun({ id: 'r1', workKind: 'feature' }) })
    });
    await waitFor(() => expect(scripted.latestStream()).toBeDefined());
    await act(async () => {
      scripted.latestStream()?.pushTransition({ id: 'e1' });
      scripted.latestStream()?.pushTransition({ id: 'e2' });
      scripted.latestStream()?.pushTransition({ id: 'e3' });
      await Promise.resolve();
    });
    await act(async () => {
      scripted.release();
    });
    await waitFor(() => expect(scripted.counts.getRun).toBe(2));
    // Give any erroneous extra refresh a chance to fire.
    await new Promise((r) => setTimeout(r, 20));
    expect(scripted.counts.getRun).toBe(2);
  });

  it('shows the reread run status even though the frame omits it', async () => {
    const withStatus = makeRun({ id: 'r1', workKind: 'feature', status: 'in_progress', waitingOn: 'human' });
    const scripted = createScriptedDetailClient({ run: withStatus });
    const replaceRun = vi.fn();
    renderHook((p: UseRunDetailOptions) => useRunDetail(p), {
      initialProps: props({ client: scripted.client, run: withStatus, replaceRun })
    });
    await waitFor(() => expect(scripted.counts.getRun).toBe(1));
    await act(async () => {
      scripted.latestStream()?.pushTransition({ id: 'e1' }); // frame run has no status
      await Promise.resolve();
    });
    await waitFor(() => expect(scripted.counts.getRun).toBe(2));
    // Every replaceRun arg is the reread run, which carries status — never the frame run.
    for (const call of replaceRun.mock.calls) {
      expect(call[0]?.status).toBe('in_progress');
    }
  });

  it('flips the spec from drafting to ready across a transition', async () => {
    const scripted = createScriptedDetailClient({ run: makeRun({ id: 'r1', workKind: 'feature' }) });
    scripted.setSpec('drafting');
    const { result } = renderHook((p: UseRunDetailOptions) => useRunDetail(p), {
      initialProps: props({ client: scripted.client, run: makeRun({ id: 'r1', workKind: 'feature' }) })
    });
    await waitFor(() => expect(result.current.spec.status).toBe('drafting'));
    scripted.setSpec('ready');
    await act(async () => {
      scripted.latestStream()?.pushTransition({ id: 'e1' });
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.spec.status).toBe('ready'));
  });
});

describe('useRunDetail lifecycle aborts', () => {
  it('aborts the prior stream when the selection changes', async () => {
    const scripted = createScriptedDetailClient({ run: makeRun({ id: 'r1' }) });
    const { rerender } = renderHook((p: UseRunDetailOptions) => useRunDetail(p), {
      initialProps: props({ client: scripted.client, run: makeRun({ id: 'r1' }) })
    });
    await waitFor(() => expect(scripted.counts.subscribe).toBe(1));
    const first = scripted.latestStream();
    rerender(props({ client: scripted.client, run: makeRun({ id: 'r2' }) }));
    await waitFor(() => expect(scripted.counts.subscribe).toBe(2));
    expect(first?.closed).toBe(true);
  });

  it('closes the stream when hidden and opens a fresh one on show', async () => {
    const scripted = createScriptedDetailClient({ run: makeRun({ id: 'r1' }) });
    const { rerender } = renderHook((p: UseRunDetailOptions) => useRunDetail(p), {
      initialProps: props({ client: scripted.client, run: makeRun({ id: 'r1' }), visible: true })
    });
    await waitFor(() => expect(scripted.counts.subscribe).toBe(1));
    const first = scripted.latestStream();
    rerender(props({ client: scripted.client, run: makeRun({ id: 'r1' }), visible: false }));
    await waitFor(() => expect(first?.closed).toBe(true));
    rerender(props({ client: scripted.client, run: makeRun({ id: 'r1' }), visible: true }));
    await waitFor(() => expect(scripted.counts.subscribe).toBe(2));
  });

  it('aborts the stream on unmount', async () => {
    const scripted = createScriptedDetailClient({ run: makeRun({ id: 'r1' }) });
    const { unmount } = renderHook((p: UseRunDetailOptions) => useRunDetail(p), {
      initialProps: props({ client: scripted.client, run: makeRun({ id: 'r1' }) })
    });
    await waitFor(() => expect(scripted.counts.subscribe).toBe(1));
    const first = scripted.latestStream();
    unmount();
    await waitFor(() => expect(first?.closed).toBe(true));
  });
});

describe('useRunDetail reconnect and error handling', () => {
  it('reconnects after an ended non-terminal stream and resumes from the last frame id', async () => {
    vi.useFakeTimers();
    const scripted = createScriptedDetailClient({ run: makeRun({ id: 'r1', terminal: false }) });
    renderHook((p: UseRunDetailOptions) => useRunDetail(p), {
      initialProps: props({ client: scripted.client, run: makeRun({ id: 'r1', terminal: false }), reconnectDelayMs: 1000 })
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(scripted.counts.subscribe).toBe(1);
    // A frame sets the cursor, then the stream ends.
    scripted.latestStream()?.pushTransition({ id: 'evt-7' });
    await vi.advanceTimersByTimeAsync(0);
    scripted.latestStream()?.close();
    await vi.advanceTimersByTimeAsync(1000);
    expect(scripted.counts.subscribe).toBe(2);
    expect(scripted.subscribeCalls[1]?.lastEventId).toBe('evt-7');
  });

  it('recovers from a 409 cursor loss by resubscribing without an id, then refreshing', async () => {
    vi.useFakeTimers();
    const scripted = createScriptedDetailClient({ run: makeRun({ id: 'r1', terminal: false }) });
    renderHook((p: UseRunDetailOptions) => useRunDetail(p), {
      initialProps: props({ client: scripted.client, run: makeRun({ id: 'r1', terminal: false }), reconnectDelayMs: 1000 })
    });
    await vi.advanceTimersByTimeAsync(0);
    const getRunAfterInitial = scripted.counts.getRun;
    scripted.latestStream()?.pushTransition({ id: 'evt-9' });
    await vi.advanceTimersByTimeAsync(0);
    scripted.latestStream()?.close();
    // The reconnect carries the cursor and is rejected as expired.
    scripted.failSubscribeOnce(cursorExpiredError());
    await vi.advanceTimersByTimeAsync(1000);
    // Second subscribe used the cursor; the third drops it.
    expect(scripted.subscribeCalls[1]?.lastEventId).toBe('evt-9');
    await vi.advanceTimersByTimeAsync(0);
    expect(scripted.counts.subscribe).toBe(3);
    expect(scripted.subscribeCalls[2]?.lastEventId).toBeUndefined();
    // A recovery refresh ran after the fresh attach.
    await vi.advanceTimersByTimeAsync(0);
    expect(scripted.counts.getRun).toBeGreaterThan(getRunAfterInitial);
  });

  it('navigates to the connection page on a 401 and stops', async () => {
    const scripted = createScriptedDetailClient({ run: makeRun({ id: 'r1' }) });
    scripted.failSubscribeOnce(unauthorizedError());
    const onUnauthorized = vi.fn();
    renderHook((p: UseRunDetailOptions) => useRunDetail(p), {
      initialProps: props({ client: scripted.client, run: makeRun({ id: 'r1' }), onUnauthorized })
    });
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
    expect(scripted.counts.getRun).toBe(0);
  });

  it('reports the run gone on a 404 and stops', async () => {
    const scripted = createScriptedDetailClient({ run: makeRun({ id: 'r1' }) });
    scripted.failSubscribeOnce(notFoundError());
    const { result } = renderHook((p: UseRunDetailOptions) => useRunDetail(p), {
      initialProps: props({ client: scripted.client, run: makeRun({ id: 'r1' }) })
    });
    await waitFor(() => expect(result.current.runGone).toBe(true));
  });

  it('keeps an open terminal stream and processes a reopening transition', async () => {
    const terminal = makeRun({ id: 'r1', status: 'failed', terminal: true, workKind: 'feature' });
    const scripted = createScriptedDetailClient({ run: terminal });
    const replaceRun = vi.fn();
    renderHook((p: UseRunDetailOptions) => useRunDetail(p), {
      initialProps: props({ client: scripted.client, run: terminal, replaceRun })
    });
    await waitFor(() => expect(scripted.counts.getRun).toBe(1));
    // Recovery reopens the run; the orchestrator pushes a transition on the still-open stream.
    const reopened = makeRun({ id: 'r1', status: 'in_progress', terminal: false, workKind: 'feature' });
    scripted.setRun(reopened);
    await act(async () => {
      scripted.latestStream()?.pushTransition({ id: 'e1', run: reopened });
      await Promise.resolve();
    });
    await waitFor(() => expect(scripted.counts.getRun).toBe(2));
    expect(replaceRun.mock.calls[replaceRun.mock.calls.length - 1]?.[0]?.terminal).toBe(false);
  });

  it('stops reconnecting once an ended stream is terminal', async () => {
    vi.useFakeTimers();
    const terminal = makeRun({ id: 'r1', status: 'done', terminal: true });
    const scripted = createScriptedDetailClient({ run: terminal });
    renderHook((p: UseRunDetailOptions) => useRunDetail(p), {
      initialProps: props({ client: scripted.client, run: terminal, reconnectDelayMs: 1000 })
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(scripted.counts.subscribe).toBe(1);
    scripted.latestStream()?.close();
    await vi.advanceTimersByTimeAsync(5000);
    // Terminal + ended → no reconnect.
    expect(scripted.counts.subscribe).toBe(1);
  });

  it('reconnects with backoff after a transient subscribe failure', async () => {
    vi.useFakeTimers();
    const scripted = createScriptedDetailClient({ run: makeRun({ id: 'r1', terminal: false }) });
    scripted.failSubscribeOnce(serverError());
    renderHook((p: UseRunDetailOptions) => useRunDetail(p), {
      initialProps: props({ client: scripted.client, run: makeRun({ id: 'r1', terminal: false }), reconnectDelayMs: 1000 })
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(scripted.counts.subscribe).toBe(1); // first attempt threw
    await vi.advanceTimersByTimeAsync(1000);
    expect(scripted.counts.subscribe).toBe(2); // retried after the base delay
  });
});

describe('useRunDetail gate decisions and feedback lifecycle', () => {
  function readyScripted(feedback?: Parameters<ReturnType<typeof createScriptedDetailClient>['setFeedback']>[0]) {
    const scripted = createScriptedDetailClient({ run: makeRun({ id: 'r1', workKind: 'feature' }) });
    scripted.setPullRequest(null);
    scripted.setSessions([makeSession()]);
    scripted.setSpec('ready');
    scripted.setSpecMarkdown('# Spec\n\nBody');
    if (feedback !== undefined) {
      scripted.setFeedback(feedback);
    }
    return scripted;
  }

  function addressedFeedback(id: string) {
    return {
      id,
      runId: 'r1',
      owner: { id: 'user-1', kind: 'human', tenantId: 'tenant-1', displayName: 'Phoebe' },
      tenant: 'tenant-1',
      target: 'artifact',
      status: 'addressed',
      title: 'T',
      body: 'B',
      thread: [{ id: `${id}-t`, author: { id: 'user-1', kind: 'human', tenantId: 'tenant-1' }, body: 'B', createdAt: '2026-11-08T00:00:00.000Z' }],
      createdAt: '2026-11-08T00:00:00.000Z',
      updatedAt: '2026-11-08T00:00:00.000Z'
    } as const;
  }

  it('sends exactly approve and refreshes the run', async () => {
    const scripted = readyScripted();
    const { result } = renderHook((p: UseRunDetailOptions) => useRunDetail(p), {
      initialProps: props({ client: scripted.client, run: makeRun({ id: 'r1', workKind: 'feature' }) })
    });
    await waitFor(() => expect(scripted.counts.getRun).toBe(1));
    let outcome: Awaited<ReturnType<typeof result.current.replyToGate>> | undefined;
    await act(async () => {
      outcome = await result.current.replyToGate('approve');
    });
    expect(scripted.replyCalls).toEqual([{ kind: 'approve' }]);
    expect(outcome).toEqual({ status: 'ok' });
    await waitFor(() => expect(scripted.counts.getRun).toBeGreaterThanOrEqual(2));
  });

  it('sends exactly request_changes', async () => {
    const scripted = readyScripted();
    const { result } = renderHook((p: UseRunDetailOptions) => useRunDetail(p), {
      initialProps: props({ client: scripted.client, run: makeRun({ id: 'r1', workKind: 'feature' }) })
    });
    await waitFor(() => expect(scripted.counts.getRun).toBe(1));
    await act(async () => {
      await result.current.replyToGate('request_changes');
    });
    expect(scripted.replyCalls).toEqual([{ kind: 'request_changes' }]);
  });

  it('returns the error on a failed decision without advancing', async () => {
    const scripted = readyScripted();
    scripted.setReplyError(serverError());
    const { result } = renderHook((p: UseRunDetailOptions) => useRunDetail(p), {
      initialProps: props({ client: scripted.client, run: makeRun({ id: 'r1', workKind: 'feature' }) })
    });
    await waitFor(() => expect(scripted.counts.getRun).toBe(1));
    let outcome: Awaited<ReturnType<typeof result.current.replyToGate>> | undefined;
    await act(async () => {
      outcome = await result.current.replyToGate('approve');
    });
    expect(outcome?.status).toBe('error');
  });

  it('resolves a comment with status resolved and refreshes', async () => {
    const scripted = readyScripted([addressedFeedback('fb-1')]);
    const { result } = renderHook((p: UseRunDetailOptions) => useRunDetail(p), {
      initialProps: props({ client: scripted.client, run: makeRun({ id: 'r1', workKind: 'feature' }) })
    });
    await waitFor(() => expect(scripted.counts.getRun).toBe(1));
    await act(async () => {
      await result.current.resolveComment('fb-1');
    });
    expect(scripted.feedbackUpdateCalls).toEqual([{ feedbackId: 'fb-1', request: { status: 'resolved' } }]);
    await waitFor(() => expect(scripted.counts.getRun).toBeGreaterThanOrEqual(2));
  });

  it('reopens a comment with the reason as the body', async () => {
    const scripted = readyScripted([{ ...addressedFeedback('fb-1'), status: 'wont_fix' }]);
    const { result } = renderHook((p: UseRunDetailOptions) => useRunDetail(p), {
      initialProps: props({ client: scripted.client, run: makeRun({ id: 'r1', workKind: 'feature' }) })
    });
    await waitFor(() => expect(scripted.counts.getRun).toBe(1));
    await act(async () => {
      await result.current.reopenComment('fb-1', 'Please reconsider');
    });
    expect(scripted.feedbackUpdateCalls).toEqual([
      { feedbackId: 'fb-1', request: { status: 'open', body: 'Please reconsider' } }
    ]);
  });

  it('returns the error on a failed resolve', async () => {
    const scripted = readyScripted([addressedFeedback('fb-1')]);
    scripted.setFeedbackUpdateError(serverError());
    const { result } = renderHook((p: UseRunDetailOptions) => useRunDetail(p), {
      initialProps: props({ client: scripted.client, run: makeRun({ id: 'r1', workKind: 'feature' }) })
    });
    await waitFor(() => expect(scripted.counts.getRun).toBe(1));
    let outcome: Awaited<ReturnType<typeof result.current.resolveComment>> | undefined;
    await act(async () => {
      outcome = await result.current.resolveComment('fb-1');
    });
    expect(outcome?.status).toBe('error');
  });
});

describe('Activity lifetime', () => {
  it('reads the workflow once for an actual initial selection under Strict Mode', async () => {
    const scripted = createScriptedDetailClient();
    renderHook(useRunDetail, { initialProps: props({ client: scripted.client }), wrapper: StrictMode });
    await waitFor(() => expect(scripted.counts.getRun).toBe(1));
    expect(scripted.counts.workflow).toBe(1);
  });

  it('restores held facts and events before any reselected reads or replay, using its own cursor', async () => {
    const selected = { ...makeRun(), currentStep: 'write' };
    const heldStep = attempt('write', 0, 0, null);
    const streamed = assistant('payload-1', 1);
    const scripted = createScriptedDetailClient({ run: selected });
    scripted.setSteps([heldStep]);
    scripted.setWorkflow(workflow());
    scripted.setSessions([makeSession()]);
    const options = props({ client: scripted.client, run: selected });
    const { rerender, result } = renderHook(useRunDetail, { initialProps: options });
    await waitFor(() => expect(result.current.activity.steps.value).toEqual([heldStep]));
    expect(scripted.subscribeCalls[0]).toMatchObject({ replay: 'retained' });
    expect(scripted.subscribeCalls[0]?.lastEventId).toBeUndefined();
    await act(async () => {
      scripted.latestStream()?.push(`id: frame-1\ndata: ${JSON.stringify(streamed)}\n\nid: cursor-only\n\n`);
    });
    const oldStream = scripted.latestStream();
    expect(result.current.activity.buffer.forAttempt(heldStep.id).map(event => event.id)).toEqual(['payload-1']);

    scripted.hold();
    scripted.setWorkflow({ ...workflow(), phases: [] });
    rerender({ ...options, run: makeRun({ id: 'run-2' }) });
    expect(oldStream?.closed).toBe(true);
    expect(result.current.activity.buffer.forAttempt(heldStep.id)).toHaveLength(0);
    expect(result.current.activity.workflow.value).toBeUndefined();
    await waitFor(() => expect(scripted.counts.workflow).toBe(2));
    rerender(options);
    expect(result.current.activity.buffer.forAttempt(heldStep.id)).toHaveLength(1);
    expect(result.current.activity.workflow.value).toEqual(workflow());
    expect(result.current.activity.steps.value).toEqual([heldStep]);
    expect(result.current.sessions.status).toBe('success');
    await waitFor(() => expect(scripted.counts.workflow).toBe(3));
    expect(scripted.subscribeCalls.at(-1)?.lastEventId).toBe('cursor-only');
    expect(scripted.subscribeCalls.at(-1)?.replay).toBeUndefined();
    await act(async () => {
      scripted.latestStream()?.push(`id: frame-replay\ndata: ${JSON.stringify(streamed)}\n\n`);
      scripted.release();
    });
    expect(result.current.activity.workflow.value?.phases).toEqual([]);
    expect(result.current.activity.buffer.forAttempt(heldStep.id)).toHaveLength(1);
  });

  it('refreshes mutable facts on recovery and cursor loss, retaining rows even through read failures', async () => {
    const selected = { ...makeRun({ status: 'failed' }), currentStep: 'error-stop' };
    const scripted = createScriptedDetailClient({ run: selected });
    const steps = [attempt('write', 0, 0, 1), attempt('error-stop', 1, 1, null)];
    scripted.setSteps(steps);
    scripted.setWorkflow(workflow());
    const options = props({ client: scripted.client, run: selected, reconnectDelayMs: 5 });
    const { result, rerender } = renderHook(useRunDetail, { initialProps: options });
    await waitFor(() => expect(result.current.activity.steps.value).toEqual(steps));

    const current = attempt('write', 2, 2, null, 2);
    const fresh = { ...makeRun(), currentStep: current.step, updatedAt: at(2) };
    scripted.setRun(fresh);
    scripted.setSteps([...steps, current]);
    scripted.setSessions([makeSession()]);
    await act(async () => {
      scripted.latestStream()?.push(`id: recovery-cursor\ndata: ${JSON.stringify({
        ...makeTransitionEvent({ run: fresh }), id: 'recover', type: 'run_recovery', runStep: current,
        transition: undefined, createdAt: at(2),
        recovery: { mode: 'resume', baseKind: 'run_branch', reDispatchStep: 'write', provisioningOutcome: 'present' }
      })}\n\n`);
    });
    await waitFor(() => expect(result.current.activity.steps.value?.at(-1)).toEqual(current));
    expect(result.current.activity.buffer.forAttempt(current.id)).toHaveLength(1);
    expect(result.current.sessions.value).toHaveLength(1);
    expect(scripted.counts.sessions).toBe(2);
    rerender({ ...options, run: fresh });

    scripted.setStepsError(serverError());
    scripted.setSessionsError(serverError());
    scripted.failSubscribeOnce(cursorExpiredError());
    await act(async () => { scripted.latestStream()?.close(); });
    // The subscribed run is kept open once its authoritative read reports recovery.
    await waitFor(() => expect(result.current.activity.replayGap).toBe(true));
    await waitFor(() => expect(result.current.activity.steps.error).toBe('Boom.'));
    expect(scripted.subscribeCalls.at(-1)).toMatchObject({ replay: 'retained' });
    expect(scripted.counts.workflow).toBe(1);
    expect(result.current.activity.steps.value?.at(-1)).toEqual(current);
    expect(result.current.activity.buffer.forAttempt(current.id)).toHaveLength(1);
    expect(result.current.sessions.status).toBe('error');
    expect(result.current.sessions.value).toHaveLength(1);

    scripted.setWorkflowError(serverError());
    rerender({ ...options, run: undefined });
    rerender(options);
    await waitFor(() => expect(result.current.activity.workflow.error).toBe('Boom.'));
    expect(result.current.activity.workflow.value).toBeUndefined();
    expect(result.current.activity.steps.value?.at(-1)).toEqual(current);
  });

  it('drops held state on principal, SDK client, or mount changes', async () => {
    const selected = { ...makeRun(), currentStep: 'write' };
    const scripted = createScriptedDetailClient({ run: selected });
    scripted.setSteps([attempt('write', 0, 0, null)]);
    const config = { ...props({ client: scripted.client, run: selected }), principalId: 'alice' };
    const { result, rerender, unmount } = renderHook(useRunDetail, { initialProps: config });
    await waitFor(() => expect(result.current.activity.steps.value).toHaveLength(1));
    await act(async () => {
      scripted.latestStream()?.push(`id: alice-cursor\ndata: ${JSON.stringify(assistant('alice event', 1))}\n\n`);
    });
    scripted.hold();
    rerender({ ...config, principalId: 'bob' });
    expect(result.current.activity.steps.value).toBeUndefined();
    expect(result.current.activity.buffer.forAttempt('attempt-0')).toEqual([]);
    expect(scripted.subscribeCalls.at(-1)).toMatchObject({ replay: 'retained' });
    const next = createScriptedDetailClient({ run: selected });
    next.hold();
    rerender({ ...config, client: next.client });
    expect(result.current.activity.steps.value).toBeUndefined();
    expect(next.subscribeCalls[0]).toMatchObject({ replay: 'retained' });
    unmount();
    const reloaded = renderHook(useRunDetail, { initialProps: config });
    expect(reloaded.result.current.activity.steps.value).toBeUndefined();
    expect(scripted.subscribeCalls.at(-1)).toMatchObject({ replay: 'retained' });
    scripted.release();
    next.release();
  });

  it('falls back to mutable reads if initial stream attachment fails', async () => {
    const scripted = createScriptedDetailClient();
    scripted.failSubscribeOnce(serverError());
    const { result } = renderHook(useRunDetail, {
      initialProps: props({ client: scripted.client, reconnectDelayMs: 30_000 })
    });
    await waitFor(() => expect(result.current.activity.steps.value).toEqual([]));
    expect(scripted.counts.steps).toBe(1);
    expect(scripted.counts.subscribe).toBe(1);
    expect(result.current.activity.connection).toBe('reconnecting');
  });
});
