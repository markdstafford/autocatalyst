import type { ResultValidationIssue } from './result-tolerance.js';

export interface ResultCorrectionRequest {
  readonly runId: string;
  readonly step: string;
  readonly schemaId: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly issues: readonly ResultValidationIssue[];
  readonly safeCandidatePreview: unknown;
}

export interface ResultCorrectionRequestInput {
  readonly runId: string;
  readonly step: string;
  readonly schemaId: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly issues: readonly ResultValidationIssue[];
  readonly candidate: unknown;
  readonly previewByteLimit?: number;
}

export interface ResultCorrectionRequester {
  requestCorrection(input: ResultCorrectionRequest): Promise<unknown>;
}

export function buildResultCorrectionRequest(input: ResultCorrectionRequestInput): ResultCorrectionRequest {
  return {
    runId: input.runId,
    step: input.step,
    schemaId: input.schemaId,
    attempt: input.attempt,
    maxAttempts: input.maxAttempts,
    issues: input.issues,
    safeCandidatePreview: createSafePreview(input.candidate, input.previewByteLimit ?? 2048)
  };
}

export function createNoopResultCorrectionRequester(): ResultCorrectionRequester {
  return {
    async requestCorrection() {
      throw new Error('Correction requester is not configured.');
    }
  };
}

function createSafePreview(candidate: unknown, byteLimit: number): unknown {
  const text = JSON.stringify(candidate, (_key, value) => typeof value === 'bigint' ? value.toString() : value);
  if (text === undefined) return null;
  if (Buffer.byteLength(text, 'utf8') <= byteLimit) return JSON.parse(text);
  return { truncated: true, preview: text.slice(0, byteLimit) };
}
