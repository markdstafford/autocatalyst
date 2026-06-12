import { describe, expect, it, vi } from 'vitest';
import type { Feedback, Run } from '@autocatalyst/api-contract';
import { assertSpecReviewGateCanAdvance } from './spec-review-gate.js';

// makeRun helper: returns a Run-like object
function makeRun(overrides: Partial<{ currentStep: string; id: string }> = {}): Run {
  return { id: 'run_1', currentStep: 'spec.human_review', ...overrides } as unknown as Run;
}

describe('assertSpecReviewGateCanAdvance', () => {
  it('passes when there is no blocking feedback', async () => {
    await expect(assertSpecReviewGateCanAdvance(
      { run: makeRun() },
      { listBlockingFeedback: async () => [] }
    )).resolves.toBeUndefined();
  });

  it('blocks open artifact feedback with safe ids', async () => {
    await expect(assertSpecReviewGateCanAdvance(
      { run: makeRun() },
      { listBlockingFeedback: async () => [{ id: 'fb_1', status: 'open', body: 'secret body' } as unknown as Feedback] }
    )).rejects.toMatchObject({ code: 'feedback_gate_blocked', blockingFeedbackIds: ['fb_1'] });
  });

  it('blocks addressed artifact feedback', async () => {
    await expect(assertSpecReviewGateCanAdvance(
      { run: makeRun() },
      { listBlockingFeedback: async () => [{ id: 'fb_2', status: 'addressed' } as unknown as Feedback] }
    )).rejects.toMatchObject({ code: 'feedback_gate_blocked', blockingFeedbackIds: ['fb_2'] });
  });

  it('rejects invalid current step', async () => {
    await expect(assertSpecReviewGateCanAdvance(
      { run: makeRun({ currentStep: 'implementation.plan' }) },
      { listBlockingFeedback: async () => [] }
    )).rejects.toMatchObject({ code: 'spec_review_invalid_step' });
  });

  it('does not call listBlockingFeedback for invalid step', async () => {
    const listBlockingFeedback = vi.fn(async () => []);
    await expect(assertSpecReviewGateCanAdvance(
      { run: makeRun({ currentStep: 'spec.author' }) },
      { listBlockingFeedback }
    )).rejects.toMatchObject({ code: 'spec_review_invalid_step' });
    expect(listBlockingFeedback).not.toHaveBeenCalled();
  });

  it('exposes all blocking feedback ids', async () => {
    const feedback = [
      { id: 'fb_1', status: 'open' },
      { id: 'fb_2', status: 'addressed' }
    ] as unknown as Feedback[];
    await expect(assertSpecReviewGateCanAdvance(
      { run: makeRun() },
      { listBlockingFeedback: async () => feedback }
    )).rejects.toMatchObject({ blockingFeedbackIds: ['fb_1', 'fb_2'] });
  });

  // Regression: API-created feedback (always starts as 'open') must block the gate.
  // This ensures feedback submitted via POST /v1/runs/:id/feedback cannot be silently
  // ignored when spec.human_review tries to advance.
  it('blocks feedback with status open — the initial status of API-created feedback', async () => {
    const apiFeedback = { id: 'fb_api', status: 'open', target: 'artifact' } as unknown as Feedback;
    await expect(assertSpecReviewGateCanAdvance(
      { run: makeRun() },
      { listBlockingFeedback: async () => [apiFeedback] }
    )).rejects.toMatchObject({ code: 'feedback_gate_blocked', blockingFeedbackIds: ['fb_api'] });
  });
});
