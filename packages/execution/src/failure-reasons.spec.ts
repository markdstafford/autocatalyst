import { describe, expect, it } from 'vitest';

import {
  classifyProviderFailure,
  formatExecutionFailureReason,
  knownFailureReasonCodes,
  knownSafeFailurePhrases,
  makeSanitizedFailureReason,
  normalizeFailureReasonForPublicSurface
} from './failure-reasons.js';
import { ClassifiedProviderFailureError, isClassifiedProviderFailureError } from './errors.js';

const sentinel = 'sk-live-secret /Users/mark/private-workspace response_body={token} https://example.test/path?api_key=secret';

describe('sanitized failure reason primitives', () => {
  it('preserves known stable failure codes', () => {
    expect(knownFailureReasonCodes).toContain('provider_auth_failed');
    expect(normalizeFailureReasonForPublicSurface('provider_auth_failed')).toBe('provider_auth_failed');
    expect(normalizeFailureReasonForPublicSurface('schema_validation_failed')).toBe('schema_validation_failed');
  });

  it('preserves exact legacy safe phrases only', () => {
    expect(knownSafeFailurePhrases).toContain('Runner failed before terminal result.');
    expect(normalizeFailureReasonForPublicSurface('Execution failed: result_file_missing')).toBe('Execution failed: result_file_missing');
    expect(normalizeFailureReasonForPublicSurface('Execution failed: result_file_missing with raw path')).toBe('runner_failed_before_terminal_result');
  });

  it('normalizes unknown and unsafe values to runner_failed_before_terminal_result', () => {
    expect(normalizeFailureReasonForPublicSurface(sentinel)).toBe('runner_failed_before_terminal_result');
    expect(normalizeFailureReasonForPublicSurface('')).toBeUndefined();
    expect(normalizeFailureReasonForPublicSurface(undefined)).toBeUndefined();
    expect(normalizeFailureReasonForPublicSurface(401)).toBeUndefined();
  });

  it('formats execution failure codes without wrapping provider_auth_failed', () => {
    expect(formatExecutionFailureReason('provider_auth_failed')).toBe('provider_auth_failed');
    expect(formatExecutionFailureReason('workspace_provisioning_failed')).toBe('workspace_provisioning_failed');
    expect(formatExecutionFailureReason('result_file_missing')).toBe('result_file_missing');
    expect(formatExecutionFailureReason('result_file_unreadable')).toBe('Execution failed: result_file_unreadable');
  });

  it('classifies HTTP 401 and auth-shaped provider errors as provider_auth_failed', () => {
    expect(classifyProviderFailure({ status: 401 })).toBe('provider_auth_failed');
    expect(classifyProviderFailure({ statusCode: 401 })).toBe('provider_auth_failed');
    expect(classifyProviderFailure({ code: 'authentication_error' })).toBe('provider_auth_failed');
    expect(classifyProviderFailure({ errorName: 'AuthenticationError' })).toBe('provider_auth_failed');
  });

  it('does not copy sentinel secrets from classification inputs', () => {
    const reason = classifyProviderFailure({
      status: 500,
      code: sentinel,
      errorName: sentinel,
      providerKind: 'openai'
    });
    expect(reason).toBeUndefined();
    expect(JSON.stringify({ reason })).not.toContain('sk-live-secret');
  });

  it('creates branded sanitized reasons only for allowlisted values', () => {
    expect(makeSanitizedFailureReason('provider_auth_failed')).toBe('provider_auth_failed');
    expect(makeSanitizedFailureReason(sentinel)).toBeUndefined();
  });

  it('provides a classified provider failure error with a fixed safe message', () => {
    const error = new ClassifiedProviderFailureError('provider_auth_failed', { providerKind: 'openai', statusCode: 401 });
    expect(error.message).toBe('Provider failure was classified for public reporting.');
    expect(error.failureReason).toBe('provider_auth_failed');
    expect(error.safeDetails).toEqual({ providerKind: 'openai', statusCode: 401 });
    expect(isClassifiedProviderFailureError(error)).toBe(true);
    expect(JSON.stringify(error)).not.toContain(sentinel);
  });
});
