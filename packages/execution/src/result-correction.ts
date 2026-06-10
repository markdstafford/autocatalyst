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
  let text: string;
  try {
    text = JSON.stringify(candidate, (_key, value) => typeof value === 'bigint' ? value.toString() : value);
  } catch {
    return null;
  }
  if (typeof text !== 'string') return null;
  if (Buffer.byteLength(text, 'utf8') <= byteLimit) return JSON.parse(text);
  const truncated = Buffer.from(text, 'utf8').subarray(0, byteLimit).toString('utf8');
  return { truncated: true, preview: truncated };
}
