import type { Feedback, FeedbackTarget, Run } from '@autocatalyst/api-contract';

export type HumanReviewGateStep = 'spec.human_review' | 'implementation.human_review';

export const gateFeedbackTargetByStep = {
  'spec.human_review': 'artifact',
  'implementation.human_review': 'implementation'
} as const satisfies Record<HumanReviewGateStep, FeedbackTarget>;

export type HumanReviewGateErrorCode = 'feedback_gate_blocked' | 'invalid_step' | 'target_mismatch';

export class HumanReviewGateError extends Error {
  readonly code: HumanReviewGateErrorCode;
  readonly blockingFeedbackIds: readonly string[];

  constructor(code: HumanReviewGateErrorCode, message: string, ids: readonly string[] = []) {
    super(message);
    this.name = 'HumanReviewGateError';
    this.code = code;
    this.blockingFeedbackIds = ids;
  }
}

export function isHumanReviewGateStep(step: string): step is HumanReviewGateStep {
  return step === 'spec.human_review' || step === 'implementation.human_review';
}

export function getHumanReviewGateFeedbackTarget(step: HumanReviewGateStep): FeedbackTarget {
  return gateFeedbackTargetByStep[step];
}

export async function assertHumanReviewGateCanAdvance(
  input: { readonly run: Run; readonly target: FeedbackTarget },
  deps: { readonly listBlockingFeedback: (input: { readonly runId: string; readonly target: FeedbackTarget }) => Promise<readonly Feedback[]> }
): Promise<void> {
  if (!isHumanReviewGateStep(input.run.currentStep)) {
    throw new HumanReviewGateError('invalid_step', `Human review gate can only run at supported review steps.`);
  }
  const expectedTarget = getHumanReviewGateFeedbackTarget(input.run.currentStep);
  if (input.target !== expectedTarget) {
    throw new HumanReviewGateError('target_mismatch', `Step '${input.run.currentStep}' uses '${expectedTarget}' feedback, not '${input.target}'.`);
  }
  const blocking = await deps.listBlockingFeedback({ runId: input.run.id, target: input.target });
  if (blocking.length > 0) {
    throw new HumanReviewGateError('feedback_gate_blocked', `Feedback blocks review approval.`, blocking.map(item => item.id));
  }
}
