import type { PullRequestFinalizeResult } from '@autocatalyst/api-contract';
import { prFinalizeResultSchema } from '@autocatalyst/api-contract';
import {
  PR_FINALIZE_SCHEMA_ID,
  prFinalizeCleanResultNormalizer,
  validateStepResult,
  type ResultCorrectionRequester,
  type ResultDegradationPolicy,
  type ResultNormalizer,
  type ResultNormalizerRegistry,
  type ResultToleranceEvent
} from '@autocatalyst/execution';

export interface ValidatePullRequestFinalizeResultInput {
  readonly runId: string;
  readonly rawResult: unknown;
  readonly correctionRequester?: ResultCorrectionRequester;
  readonly maxCorrectionAttempts?: number;
  readonly normalizers?: ResultNormalizerRegistry | readonly ResultNormalizer[];
  readonly degradationPolicy?: ResultDegradationPolicy;
}

export interface PullRequestFinalizeResultValidationSuccess {
  readonly status: 'valid';
  readonly value: PullRequestFinalizeResult;
  readonly events: readonly ResultToleranceEvent[];
  readonly normalized: boolean;
  readonly correctedAttempts: number;
}

export interface PullRequestFinalizeResultValidationFailure {
  readonly status: 'failed';
  readonly reason: 'pr_finalize_invalid_result';
  readonly events: readonly ResultToleranceEvent[];
}

export type PullRequestFinalizeResultValidationOutcome =
  | PullRequestFinalizeResultValidationSuccess
  | PullRequestFinalizeResultValidationFailure;

export async function validatePullRequestFinalizeResult(
  input: ValidatePullRequestFinalizeResultInput
): Promise<PullRequestFinalizeResultValidationOutcome> {
  const validation = await validateStepResult({
    runId: input.runId,
    step: 'pr.finalize',
    schemaId: PR_FINALIZE_SCHEMA_ID,
    schema: prFinalizeResultSchema,
    candidate: input.rawResult,
    normalizers: input.normalizers ?? [prFinalizeCleanResultNormalizer],
    ...(input.correctionRequester !== undefined ? { correctionRequester: input.correctionRequester } : {}),
    ...(input.maxCorrectionAttempts !== undefined ? { maxCorrectionAttempts: input.maxCorrectionAttempts } : {}),
    ...(input.degradationPolicy !== undefined ? { degradationPolicy: input.degradationPolicy } : {})
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
  return { status: 'failed', reason: 'pr_finalize_invalid_result', events: validation.events };
}
