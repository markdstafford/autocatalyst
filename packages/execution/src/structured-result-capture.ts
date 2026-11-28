import { TESTING_GUIDE_SCHEMA_ID } from '@autocatalyst/api-contract';
import { z } from 'zod';
import type { StepResultContractDefinition } from './result-contracts.js';
import type { ResultValidationIssue } from './result-tolerance.js';
import { ProviderProtocolError } from './agent-provider-adapter.js';

export interface StructuredAgentResultCapture {
  readonly step: string;
  readonly schemaId: string;
  readonly schema: z.ZodTypeAny;
  readonly resultFile: string;
  readonly required: true;
}

export type StructuredAgentResultCaptureMechanism = 'openai_output_type' | 'claude_structured_output';

export interface CreateStructuredAgentResultCaptureInput {
  readonly mode: 'none' | 'scratch_file';
  readonly step?: string;
  readonly contract?: StepResultContractDefinition;
}

export interface StructuredAgentResultCaptureResolutionSuccess {
  readonly status: 'capture';
  readonly capture: StructuredAgentResultCapture;
}

export interface StructuredAgentResultCaptureResolutionSkipped {
  readonly status: 'skipped';
  readonly reason: 'mode_none' | 'no_contract';
}

export interface StructuredAgentResultCaptureResolutionFailure {
  readonly status: 'failed';
  readonly code: 'result_file_missing' | 'step_result_contract_unknown';
  readonly safeMessage: string;
  readonly issues?: readonly ResultValidationIssue[];
}

export type StructuredAgentResultCaptureResolution =
  | StructuredAgentResultCaptureResolutionSuccess
  | StructuredAgentResultCaptureResolutionSkipped
  | StructuredAgentResultCaptureResolutionFailure;

export function createStructuredAgentResultCapture(
  input: CreateStructuredAgentResultCaptureInput
): StructuredAgentResultCaptureResolution {
  if (input.mode === 'none') return { status: 'skipped', reason: 'mode_none' };
  if (input.contract === undefined) return { status: 'skipped', reason: 'no_contract' };
  if (input.contract.schemaId === 'any') return { status: 'skipped', reason: 'no_contract' };
  if (input.contract.resultFile === undefined || input.contract.resultFile.length === 0) {
    const safeMessage = 'Step result contract does not declare a result file.';
    return {
      status: 'failed',
      code: 'result_file_missing',
      safeMessage,
      issues: [{ code: 'result_file_missing', path: [], message: safeMessage }]
    };
  }
  if (
    input.step !== undefined &&
    input.step.length > 0 &&
    input.step !== input.contract.step
  ) {
    const safeMessage = 'Resolved step result contract does not match the active step.';
    return {
      status: 'failed',
      code: 'step_result_contract_unknown',
      safeMessage,
      issues: [{ code: 'step_result_contract_unknown', path: ['step'], message: safeMessage }]
    };
  }
  return {
    status: 'capture',
    capture: {
      step: input.contract.step,
      schemaId: input.contract.schemaId,
      schema: input.contract.schema,
      resultFile: input.contract.resultFile,
      required: true
    }
  };
}

export function assertSerializableStructuredResult(value: unknown): void {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError('Structured result is not JSON serializable.');
    JSON.parse(encoded);
  } catch {
    throw new ProviderProtocolError(
      'structured_result_invalid',
      'Provider returned a structured result that cannot be safely serialized as JSON.'
    );
  }
}

const specQuestionResultSchema = z.object({
  directive: z.literal('needs_input'),
  question: z.string().refine(question => question.trim().length > 0)
}).strict();

export function isReviewedSpecCapture(capture: StructuredAgentResultCapture | undefined): boolean {
  return capture?.step === 'spec.author' &&
    (capture.schemaId === 'autocatalyst.reviewer_result.v1' || capture.schemaId === 'autocatalyst.reviewed_spec_author.v1');
}

export function decodeSpecRoleProviderResult(capture: StructuredAgentResultCapture, value: unknown):
  { kind: 'complete'; value: unknown } | { kind: 'question'; question: string } {
  if (!isReviewedSpecCapture(capture)) return { kind: 'complete', value };
  const payload = value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === 1 && 'response' in value ? value.response : value;
  const question = specQuestionResultSchema.safeParse(payload);
  return question.success ? { kind: 'question', question: question.data.question } : { kind: 'complete', value: payload };
}

/** OpenAI strict JSON requires optional keys to be present and nullable. */
export function decodeTestingGuideOpenAIResult(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || !('items' in value) || !Array.isArray(value.items)) return value;
  return { ...value, items: value.items.map(item => {
    if (item === null || typeof item !== 'object' || item.expected !== null) return item as unknown;
    const { expected: _expected, ...present } = item;
    return present;
  }) };
}

export function isTestingGuideCapture(capture: StructuredAgentResultCapture | undefined): boolean {
  return capture?.schemaId === TESTING_GUIDE_SCHEMA_ID;
}
