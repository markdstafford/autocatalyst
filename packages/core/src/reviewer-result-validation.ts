import type { ReviewerResult } from '@autocatalyst/api-contract';
import { reviewerResultSchema } from '@autocatalyst/api-contract';
import {
  REVIEWER_RESULT_SCHEMA_ID,
  validateStepResult,
  type ResultCorrectionRequester,
  type ResultNormalizer,
  type ResultNormalizerRegistry,
  type ResultToleranceEvent
} from '@autocatalyst/execution';

export interface ValidateReviewerResultInput {
  readonly runId: string;
  readonly step: string;
  readonly rawResult: unknown;
  readonly correctionRequester?: ResultCorrectionRequester;
  readonly maxCorrectionAttempts?: number;
  readonly normalizers?: ResultNormalizerRegistry | readonly ResultNormalizer[];
}

export type ReviewerResultValidationOutcome =
  | ReviewerResultValidationSuccess
  | ReviewerResultValidationFailure;

export interface ReviewerResultValidationSuccess {
  readonly status: 'valid';
  readonly value: ReviewerResult;
  readonly events: readonly ResultToleranceEvent[];
  readonly normalized: boolean;
  readonly correctedAttempts: number;
}

export interface ReviewerResultValidationFailure {
  readonly status: 'failed';
  readonly reason: 'reviewer_result_invalid';
  readonly events: readonly ResultToleranceEvent[];
}

export async function validateReviewerResult(
  input: ValidateReviewerResultInput
): Promise<ReviewerResultValidationOutcome> {
  const validation = await validateStepResult({
    runId: input.runId,
    step: input.step,
    schemaId: REVIEWER_RESULT_SCHEMA_ID,
    schema: reviewerResultSchema,
    candidate: input.rawResult,
    ...(input.correctionRequester !== undefined ? { correctionRequester: input.correctionRequester } : {}),
    ...(input.maxCorrectionAttempts !== undefined ? { maxCorrectionAttempts: input.maxCorrectionAttempts } : {}),
    ...(input.normalizers !== undefined ? { normalizers: input.normalizers } : {})
  });

  if (validation.status === 'valid') {
    return {
      status: 'valid',
      value: validation.value,
      events: validation.events,
      normalized: validation.normalized,
      correctedAttempts: validation.correctedAttempts
    };
  }

  return {
    status: 'failed',
    reason: 'reviewer_result_invalid',
    events: validation.events
  };
}
