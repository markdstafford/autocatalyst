import type { ProviderFailureClassificationInput, SanitizedFailureReason } from './failure-reasons.js';

export class ClassifiedProviderFailureError extends Error {
  readonly failureReason: SanitizedFailureReason;
  readonly safeDetails?: ProviderFailureClassificationInput;

  constructor(failureReason: SanitizedFailureReason, safeDetails?: ProviderFailureClassificationInput) {
    super('Provider failure was classified for public reporting.');
    this.name = 'ClassifiedProviderFailureError';
    this.failureReason = failureReason;
    if (safeDetails !== undefined) {
      this.safeDetails = safeDetails;
    }
  }
}

export function isClassifiedProviderFailureError(error: unknown): error is ClassifiedProviderFailureError {
  return error instanceof ClassifiedProviderFailureError;
}
