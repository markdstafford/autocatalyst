import type { Run, Feedback } from '@autocatalyst/api-contract';
import { assertHumanReviewGateCanAdvance, HumanReviewGateError } from './human-review-gate.js';

export class SpecReviewGateBlockedError extends Error {
  readonly code: 'feedback_gate_blocked' | 'spec_review_invalid_step';
  readonly blockingFeedbackIds: readonly string[];
  constructor(code: SpecReviewGateBlockedError['code'], message: string, ids: readonly string[] = []) {
    super(message);
    this.name = 'SpecReviewGateBlockedError';
    this.code = code;
    this.blockingFeedbackIds = ids;
  }
}

export async function assertSpecReviewGateCanAdvance(
  input: { readonly run: Run },
  deps: { readonly listBlockingFeedback: (input: { readonly runId: string; readonly target: 'artifact' }) => Promise<readonly Feedback[]> }
): Promise<void> {
  try {
    await assertHumanReviewGateCanAdvance({ run: input.run, target: 'artifact' }, deps);
  } catch (error) {
    if (error instanceof HumanReviewGateError) {
      const code = error.code === 'feedback_gate_blocked' ? 'feedback_gate_blocked' : 'spec_review_invalid_step';
      throw new SpecReviewGateBlockedError(code, error.message, error.blockingFeedbackIds);
    }
    throw error;
  }
}
