/**
 * SpecReview card lifecycle (controlled mode): the controller-driven Resolve/Reopen actions, the
 * reopen reason prompt, the resolved-style dimming, and per-card error display. The controller is a
 * stub so these assertions stay at the SpecReview/controller seam.
 */
import type { FeedbackResponse } from '@autocatalyst/api-contract';
import { fireEvent, render, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SpecReview } from './spec-review.js';
import type { CardActionState, SpecReviewController } from '../../runs/use-spec-review-controller.js';

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

function anchor(from: number, to: number): FeedbackResponse['anchor'] {
  return { kind: 'artifact_range', artifactId: 'artifact-1', from, to, quotedText: 'x' } as FeedbackResponse['anchor'];
}

function stubController(overrides: Partial<SpecReviewController> = {}): SpecReviewController {
  return {
    selectedId: null,
    order: [],
    hasComments: true,
    openCount: 0,
    resolvedCount: 0,
    canPrevious: false,
    canNext: false,
    navSignal: 0,
    navTargetId: null,
    navTargetKind: null,
    select: vi.fn(),
    selectNext: vi.fn(),
    selectPrevious: vi.fn(),
    cardState: (): CardActionState => ({ busy: false }),
    canResolve: () => false,
    canReopen: () => false,
    resolve: vi.fn(),
    reopen: vi.fn(),
    ...overrides
  };
}

function renderReview(controller: SpecReviewController, feedbackList: FeedbackResponse[]): HTMLElement {
  const { container } = render(
    <SpecReview
      markdown={MARKDOWN}
      artifactId="artifact-1"
      feedback={feedbackList}
      canComment
      controller={controller}
      onCreateComment={vi.fn(async () => ({ status: 'created' }) as const)}
      onReloadNeeded={vi.fn()}
      nowIso={NOW}
    />
  );
  return container as HTMLElement;
}

describe('SpecReview lifecycle actions', () => {
  it('shows Resolve on an addressed card and calls the controller', () => {
    const resolve = vi.fn();
    const controller = stubController({ canResolve: (id) => id === 'a1', resolve });
    const root = renderReview(controller, [feedback({ id: 'a1', status: 'addressed', anchor: anchor(2, 4) })]);
    fireEvent.click(within(root).getByTestId('resolve-a1'));
    expect(resolve).toHaveBeenCalledWith('a1');
  });

  it('shows Reopen on a wont_fix card but not on a resolved card', () => {
    const controller = stubController({ canReopen: (id) => id === 'w1' });
    const root = renderReview(controller, [
      feedback({ id: 'w1', status: 'wont_fix', anchor: anchor(2, 4) }),
      feedback({ id: 'r1', status: 'resolved', anchor: anchor(6, 8) })
    ]);
    expect(within(root).queryByTestId('reopen-w1')).not.toBeNull();
    expect(within(root).queryByTestId('reopen-r1')).toBeNull();
  });

  it('requires a non-empty reason before reopening', () => {
    const reopen = vi.fn();
    const controller = stubController({ canReopen: (id) => id === 'w1', reopen });
    const root = renderReview(controller, [feedback({ id: 'w1', status: 'wont_fix', anchor: anchor(2, 4) })]);
    fireEvent.click(within(root).getByTestId('reopen-w1'));
    const confirm = within(root).getByTestId('reopen-confirm-w1') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(root).getByTestId('reopen-reason-w1'), { target: { value: 'Please reconsider' } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    expect(reopen).toHaveBeenCalledWith('w1', 'Please reconsider');
  });

  it('renders a per-card error from the controller state', () => {
    const controller = stubController({
      canResolve: (id) => id === 'a1',
      cardState: (id) => (id === 'a1' ? { busy: false, error: 'Already resolved.' } : { busy: false })
    });
    const root = renderReview(controller, [feedback({ id: 'a1', status: 'addressed', anchor: anchor(2, 4) })]);
    expect(within(root).getByTestId('card-error-a1').textContent).toBe('Already resolved.');
  });

  it('dims resolved and wont_fix cards but not addressed cards', () => {
    const controller = stubController();
    const root = renderReview(controller, [
      feedback({ id: 'a1', status: 'addressed', anchor: anchor(2, 4) }),
      feedback({ id: 'r1', status: 'resolved', anchor: anchor(6, 8) }),
      feedback({ id: 'w1', status: 'wont_fix', anchor: anchor(10, 12) })
    ]);
    expect(root.querySelector('[data-card-for="a1"]')?.className).not.toContain('opacity-80');
    expect(root.querySelector('[data-card-for="r1"]')?.className).toContain('opacity-80');
    expect(root.querySelector('[data-card-for="w1"]')?.className).toContain('opacity-80');
  });
});
