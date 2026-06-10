import type { z } from 'zod';
import { buildResultCorrectionRequest } from './result-correction.js';
import type { ResultCorrectionRequester } from './result-correction.js';
import { createResultNormalizerRegistry } from './result-normalizers.js';
import type { ResultNormalizer, ResultNormalizerRegistry } from './result-normalizers.js';

export const defaultStepResultCorrectionMaxAttempts = 2;

export type StepResultValidationFailureCode =
  | 'result_contract_missing'
  | 'result_contract_unknown'
  | 'result_file_missing'
  | 'result_file_unreadable'
  | 'result_json_invalid'
  | 'schema_validation_failed'
  | 'correction_attempts_exhausted'
  | 'correction_request_failed'
  | 'normalizer_failed'
  | 'result_path_outside_scratch_root';

export interface ResultValidationIssue {
  readonly code: string;
  readonly path: readonly (string | number)[];
  readonly message: string;
}

export interface ResultToleranceEvent {
  readonly kind: 'accepted' | 'normalized' | 'ambiguous' | 'corrected' | 'degraded' | 'failed';
  readonly code?: StepResultValidationFailureCode | 'ambiguous_normalization' | string;
  readonly path?: readonly (string | number)[];
  readonly normalizerId?: string;
  readonly attempt?: number;
  readonly message: string;
}

export interface ResultDegradationPolicy {
  readonly optionalPaths: readonly (readonly (string | number)[])[];
}

export interface ValidateStepResultInput<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  readonly runId: string;
  readonly step: string;
  readonly schemaId: string;
  readonly schema: TSchema;
  readonly candidate: unknown;
  readonly normalizers?: ResultNormalizerRegistry | readonly ResultNormalizer[];
  readonly correctionRequester?: ResultCorrectionRequester;
  readonly maxCorrectionAttempts?: number;
  readonly degradationPolicy?: ResultDegradationPolicy;
}

export type StepResultValidationOutcome<TValue = unknown> =
  | StepResultValidationSuccess<TValue>
  | StepResultValidationFailure;

export interface StepResultValidationSuccess<TValue = unknown> {
  readonly status: 'valid';
  readonly value: TValue;
  readonly schemaId: string;
  readonly normalized: boolean;
  readonly correctedAttempts: number;
  readonly degraded: boolean;
  readonly degradedPaths: readonly (readonly (string | number)[])[];
  readonly events: readonly ResultToleranceEvent[];
}

export interface StepResultValidationFailure {
  readonly status: 'failed';
  readonly code: StepResultValidationFailureCode;
  readonly schemaId: string;
  readonly attempts: number;
  readonly safeMessage: string;
  readonly issues: readonly ResultValidationIssue[];
  readonly events: readonly ResultToleranceEvent[];
}

export async function validateStepResult<TSchema extends z.ZodTypeAny>(
  input: ValidateStepResultInput<TSchema>
): Promise<StepResultValidationOutcome<z.infer<TSchema>>> {
  const maxAttempts = input.maxCorrectionAttempts ?? defaultStepResultCorrectionMaxAttempts;
  const registry = Array.isArray(input.normalizers)
    ? createResultNormalizerRegistry(input.normalizers as readonly ResultNormalizer[])
    : (input.normalizers as ResultNormalizerRegistry | undefined) ?? createResultNormalizerRegistry();

  let candidate = input.candidate;
  let attempts = 0;
  let normalizedAny = false;
  const events: ResultToleranceEvent[] = [];

  while (true) {
    const normalization = registry.normalize({
      candidate,
      runId: input.runId,
      step: input.step,
      schemaId: input.schemaId,
      attempt: attempts
    });
    events.push(...normalization.events);

    if (normalization.failed) {
      return makeFailure('normalizer_failed', input.schemaId, attempts, 'Step result normalization failed.', [], events);
    }

    normalizedAny = normalizedAny || normalization.normalized;
    candidate = normalization.candidate;

    const parsed = input.schema.safeParse(candidate);
    if (parsed.success) {
      const degradedPaths = findDegradedPaths(parsed.data, input.degradationPolicy);
      return {
        status: 'valid',
        value: parsed.data,
        schemaId: input.schemaId,
        normalized: normalizedAny,
        correctedAttempts: attempts,
        degraded: degradedPaths.length > 0,
        degradedPaths,
        events: [
          ...events,
          ...degradedPaths.map((path): ResultToleranceEvent => ({
            kind: 'degraded',
            path,
            message: `Optional result path '${path.join('.')}' is missing.`
          })),
          { kind: 'accepted', message: 'Step result accepted.' }
        ]
      };
    }

    const issues: ResultValidationIssue[] = parsed.error.issues.map((issue) => ({
      code: issue.code,
      path: issue.path,
      message: issue.message
    }));

    if (attempts >= maxAttempts || input.correctionRequester === undefined) {
      const code: StepResultValidationFailureCode =
        attempts >= maxAttempts && maxAttempts > 0
          ? 'correction_attempts_exhausted'
          : 'schema_validation_failed';
      return makeFailure(
        code,
        input.schemaId,
        attempts,
        code === 'schema_validation_failed'
          ? 'Step result failed schema validation.'
          : 'Step result correction attempts exhausted.',
        issues,
        events
      );
    }

    attempts += 1;
    try {
      const request = buildResultCorrectionRequest({
        runId: input.runId,
        step: input.step,
        schemaId: input.schemaId,
        attempt: attempts,
        maxAttempts,
        issues,
        candidate
      });
      candidate = await input.correctionRequester.requestCorrection(request);
      events.push({ kind: 'corrected', attempt: attempts, message: 'Correction candidate received.' });
    } catch {
      return makeFailure('correction_request_failed', input.schemaId, attempts, 'Step result correction request failed.', issues, events);
    }
  }
}

function makeFailure(
  code: StepResultValidationFailureCode,
  schemaId: string,
  attempts: number,
  safeMessage: string,
  issues: readonly ResultValidationIssue[],
  events: readonly ResultToleranceEvent[]
): StepResultValidationFailure {
  return {
    status: 'failed',
    code,
    schemaId,
    attempts,
    safeMessage,
    issues,
    events: [...events, { kind: 'failed', code, message: safeMessage }]
  };
}

function findDegradedPaths(
  value: unknown,
  policy: ResultDegradationPolicy | undefined
): readonly (readonly (string | number)[])[] {
  if (policy === undefined) return [];
  return policy.optionalPaths.filter((path) => isMissingOrUndefinedAtPath(value, path));
}

function isMissingOrUndefinedAtPath(value: unknown, path: readonly (string | number)[]): boolean {
  let current = value;
  for (const segment of path) {
    if (typeof segment === 'number') {
      if (!Array.isArray(current) || segment < 0 || segment >= current.length) return true;
      current = (current as unknown[])[segment];
    } else {
      if (current === null || typeof current !== 'object' || Array.isArray(current) || !(segment in current)) return true;
      current = (current as Record<string, unknown>)[segment];
    }
  }
  return current === undefined;
}
