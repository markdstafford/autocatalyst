import type { Run } from '@autocatalyst/api-contract';
import type { Feedback } from '@autocatalyst/api-contract';

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
  if (input.run.currentStep !== 'spec.human_review') {
    throw new SpecReviewGateBlockedError('spec_review_invalid_step', 'Spec review gate can only run at spec.human_review.');
  }
  const blocking = await deps.listBlockingFeedback({ runId: input.run.id, target: 'artifact' });
  if (blocking.length > 0) {
    throw new SpecReviewGateBlockedError('feedback_gate_blocked', 'Artifact feedback blocks spec approval.', blocking.map((item) => item.id));
  }
}
