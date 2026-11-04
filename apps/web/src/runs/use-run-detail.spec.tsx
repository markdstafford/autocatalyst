/**
 * Detail-pane data-hook tests with a scripted SDK client: stream-first initial reads,
 * a transition delivered between attach and initial-read completion, coalesced
 * refreshes, selection/hide/unmount aborts, reread-not-copied status, spec flip across a
 * transition, reconnect backoff + resume id, 409 cursor-loss recovery, 401, 404, and
 * terminal-stream stop behavior.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeRun, makeSession } from './run-fixtures.js';
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
