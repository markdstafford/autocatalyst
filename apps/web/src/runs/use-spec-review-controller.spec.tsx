/**
 * useSpecReviewController tests: document-order navigation, open/resolved counts, originator-only
 * lifecycle gating (resolve on addressed, reopen on wont_fix, only at the gate and for the current
 * operator), and the resolve/reopen action state including control-plane error surfacing.
 */
import type { FeedbackResponse, Run } from '@autocatalyst/api-contract';
import { ControlPlaneClientError } from '@autocatalyst/sdk';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { makeRun } from './run-fixtures.js';
import type { RunActionResult } from './use-run-detail.js';
import { useSpecReviewController } from './use-spec-review-controller.js';

const NOW = '2026-11-08T01:00:00.000Z';
const MARKDOWN = 'abcdefghijklmnopqrstuvwxyz';

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

function anchor(from: number, to: number, stale?: boolean): FeedbackResponse['anchor'] {
  return { kind: 'artifact_range', artifactId: 'artifact-1', from, to, quotedText: 'x', ...(stale ? { stale: true } : {}) } as FeedbackResponse['anchor'];
}

function setup(options?: {
  feedback?: FeedbackResponse[];
  run?: Run;
  currentPrincipalId?: string;
  resolveComment?: () => Promise<RunActionResult>;
  reopenComment?: () => Promise<RunActionResult>;
}) {
  const resolveComment = vi.fn(options?.resolveComment ?? (async (): Promise<RunActionResult> => ({ status: 'ok' })));
  const reopenComment = vi.fn(options?.reopenComment ?? (async (): Promise<RunActionResult> => ({ status: 'ok' })));
  const principalId = options !== undefined && 'currentPrincipalId' in options ? options.currentPrincipalId : 'user-1';
  const hook = renderHook(() =>
    useSpecReviewController({
      feedback: options?.feedback ?? [],
      markdown: MARKDOWN,
      run: options?.run ?? makeRun({ id: 'run-1', workKind: 'feature' }),
      currentPrincipalId: principalId,
      resolveComment,
      reopenComment
    })
  );
  return { hook, resolveComment, reopenComment };
}

describe('useSpecReviewController — order and counts', () => {
  it('orders anchored comments in document order, then stale, then no-range', () => {
    const { hook } = setup({
      feedback: [
        feedback({ id: 'c2', anchor: anchor(10, 12) }),
        feedback({ id: 'c1', anchor: anchor(2, 4) }),
        feedback({ id: 's1', anchor: anchor(5, 7, true) }),
        feedback({ id: 'n1', anchor: undefined })
      ]
    });
    expect(hook.result.current.order.map((item) => item.id)).toEqual(['c1', 'c2', 's1', 'n1']);
  });

  it('counts open and resolved-style artifact feedback', () => {
    const { hook } = setup({
      feedback: [
        feedback({ id: 'c1', anchor: anchor(2, 4) }),
        feedback({ id: 'c2', status: 'open', anchor: anchor(6, 8) }),
        feedback({ id: 'a1', status: 'addressed', anchor: anchor(10, 12) }),
        feedback({ id: 'w1', status: 'wont_fix', anchor: undefined }),
        feedback({ id: 'r1', status: 'resolved', anchor: anchor(14, 16) })
      ]
    });
    expect(hook.result.current.openCount).toBe(2);
    expect(hook.result.current.resolvedCount).toBe(3);
  });
});

describe('useSpecReviewController — navigation', () => {
  it('steps forward and back in document order with bounds', () => {
    const { hook } = setup({
      feedback: [feedback({ id: 'c1', anchor: anchor(2, 4) }), feedback({ id: 'c2', anchor: anchor(10, 12) })]
    });
    expect(hook.result.current.canPrevious).toBe(false);
    expect(hook.result.current.canNext).toBe(true);

    act(() => hook.result.current.selectNext());
    expect(hook.result.current.selectedId).toBe('c1');
    expect(hook.result.current.canPrevious).toBe(false);

    act(() => hook.result.current.selectNext());
    expect(hook.result.current.selectedId).toBe('c2');
    expect(hook.result.current.canNext).toBe(false);
    expect(hook.result.current.canPrevious).toBe(true);

    act(() => hook.result.current.selectPrevious());
    expect(hook.result.current.selectedId).toBe('c1');
  });

  it('bumps the nav signal with a marker target for anchored and a card target for no-range', () => {
    const { hook } = setup({
      feedback: [feedback({ id: 'c1', anchor: anchor(2, 4) }), feedback({ id: 'n1', anchor: undefined })]
    });
    const before = hook.result.current.navSignal;
    act(() => hook.result.current.select('c1', 'marker'));
    expect(hook.result.current.navSignal).toBe(before + 1);
    expect(hook.result.current.navTargetKind).toBe('marker');
    act(() => hook.result.current.selectNext());
    expect(hook.result.current.navTargetId).toBe('n1');
    expect(hook.result.current.navTargetKind).toBe('card');
  });
});

describe('useSpecReviewController — lifecycle gating', () => {
  it('allows resolve on an addressed card by the current operator at the gate', () => {
    const { hook } = setup({ feedback: [feedback({ id: 'a1', status: 'addressed', anchor: anchor(2, 4) })] });
    expect(hook.result.current.canResolve('a1')).toBe(true);
    expect(hook.result.current.canReopen('a1')).toBe(false);
  });

  it('allows reopen on a wont_fix card but never on a resolved card', () => {
    const { hook } = setup({
      feedback: [
        feedback({ id: 'w1', status: 'wont_fix', anchor: anchor(2, 4) }),
        feedback({ id: 'r1', status: 'resolved', anchor: anchor(6, 8) })
      ]
    });
    expect(hook.result.current.canReopen('w1')).toBe(true);
    expect(hook.result.current.canReopen('r1')).toBe(false);
  });

  it('hides lifecycle actions for another operator and for unknown identity', () => {
    const other = setup({ feedback: [feedback({ id: 'a1', status: 'addressed', anchor: anchor(2, 4) })], currentPrincipalId: 'user-2' });
    expect(other.hook.result.current.canResolve('a1')).toBe(false);
    const unknown = setup({ feedback: [feedback({ id: 'a1', status: 'addressed', anchor: anchor(2, 4) })], currentPrincipalId: undefined });
    expect(unknown.hook.result.current.canResolve('a1')).toBe(false);
  });

  it('hides lifecycle actions when the run is not at the spec gate', () => {
    const run = { ...makeRun({ id: 'run-1', workKind: 'feature' }), currentStep: 'implementation.human_review' };
    const { hook } = setup({ feedback: [feedback({ id: 'a1', status: 'addressed', anchor: anchor(2, 4) })], run });
    expect(hook.result.current.canResolve('a1')).toBe(false);
  });
});

describe('useSpecReviewController — action state', () => {
  it('calls resolveComment and clears state on success', async () => {
    const { hook, resolveComment } = setup({ feedback: [feedback({ id: 'a1', status: 'addressed', anchor: anchor(2, 4) })] });
    act(() => hook.result.current.resolve('a1'));
    expect(resolveComment).toHaveBeenCalledWith('a1');
    await waitFor(() => expect(hook.result.current.cardState('a1').busy).toBe(false));
    expect(hook.result.current.cardState('a1').error).toBeUndefined();
  });

  it('surfaces the control-plane message on a resolve error', async () => {
    const error = new ControlPlaneClientError(409, { error: { code: 'conflict', message: 'Already resolved.' } });
    const { hook } = setup({
      feedback: [feedback({ id: 'a1', status: 'addressed', anchor: anchor(2, 4) })],
      resolveComment: async () => ({ status: 'error', error })
    });
    act(() => hook.result.current.resolve('a1'));
    await waitFor(() => expect(hook.result.current.cardState('a1').error).toBe('Already resolved.'));
  });

  it('sends the reopen reason as the body', () => {
    const { hook, reopenComment } = setup({ feedback: [feedback({ id: 'w1', status: 'wont_fix', anchor: anchor(2, 4) })] });
    act(() => hook.result.current.reopen('w1', 'Please reconsider'));
    expect(reopenComment).toHaveBeenCalledWith('w1', 'Please reconsider');
  });
});
