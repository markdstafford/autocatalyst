import { describe, expect, it } from 'vitest';

import {
  classifyProviderFailure,
  filterSafeClassificationDetails,
  formatExecutionFailureReason,
  knownFailureReasonCodes,
  knownSafeFailurePhrases,
  makeSanitizedFailureReason,
  normalizeFailureReasonForPublicSurface
} from './failure-reasons.js';
import { ClassifiedProviderFailureError, isClassifiedProviderFailureError } from './errors.js';

const sentinel = 'sk-live-secret /Users/mark/private-workspace response_body={token} https://example.test/path?api_key=secret';

function expectNoSentinels(serialized: string): void {
  expect(serialized).not.toContain('sk-test-secret');
  expect(serialized).not.toContain('authorization: Bearer');
  expect(serialized).not.toContain('/Users/mark/private');
  expect(serialized).not.toContain('sec_secret_handle_value');
  expect(serialized).not.toContain('raw SDK diagnostic');
}

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

  it('preserves Execution failed: result_json_invalid for public surface', () => {
    const reason = 'Execution failed: result_json_invalid';
    const normalized = normalizeFailureReasonForPublicSurface(reason);
    expect(normalized).toBe('Execution failed: result_json_invalid');
    // ensure no raw sensitive data leaks
    expect(JSON.stringify({ normalized })).not.toContain('sk-ant');
    expect(JSON.stringify({ normalized })).not.toContain('/Users/');
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

  it('does not copy any sentinel values from classification inputs into outputs', () => {
    const unsafeInput = {
      status: 500,
      code: 'sk-test-secret',
      errorName: 'authorization: Bearer sk-test-secret',
      providerKind: '/Users/mark/private',
      message: 'sec_secret_handle_value raw SDK diagnostic'
    };
    const reason = classifyProviderFailure(unsafeInput);
    expectNoSentinels(JSON.stringify({ reason }));
    const normalized = normalizeFailureReasonForPublicSurface('sk-test-secret authorization: Bearer /Users/mark/private sec_secret_handle_value raw SDK diagnostic');
    expectNoSentinels(JSON.stringify({ normalized }));
    const made = makeSanitizedFailureReason('sk-test-secret');
    expectNoSentinels(JSON.stringify({ made }));
  });

  it('filterSafeClassificationDetails strips non-allowlisted code and errorName', () => {
    const unsafeCode = 'sk-test-secret /Users/mark/private raw SDK diagnostic';
    const unsafeName = 'authorization: Bearer sec_secret_handle_value';
    const filtered = filterSafeClassificationDetails({
      status: 401,
      code: unsafeCode,
      errorName: unsafeName,
      providerKind: 'openai'
    });
    expect(JSON.stringify(filtered)).not.toContain('sk-test-secret');
    expect(JSON.stringify(filtered)).not.toContain('/Users/mark/private');
    expect(JSON.stringify(filtered)).not.toContain('authorization: Bearer');
    expect(JSON.stringify(filtered)).not.toContain('sec_secret_handle_value');
    expect(filtered).toMatchObject({ status: 401, providerKind: 'openai' });
    expect(filtered).not.toHaveProperty('code');
    expect(filtered).not.toHaveProperty('errorName');
  });

  it('filterSafeClassificationDetails retains allowlisted code and errorName', () => {
    const filtered = filterSafeClassificationDetails({
      statusCode: 401,
      code: 'invalid_api_key',
      errorName: 'AuthenticationError',
      providerKind: 'anthropic'
    });
    expect(filtered).toMatchObject({
      statusCode: 401,
      code: 'invalid_api_key',
      errorName: 'AuthenticationError',
      providerKind: 'anthropic'
    });
  });

  it('ClassifiedProviderFailureError built from 401 with sentinel code/name does not serialize sentinels', () => {
    const sentinelCode = 'sk-test-secret /Users/mark/private';
    const sentinelName = 'authorization: Bearer sec_secret_handle_value';
    const rawInput = {
      status: 401,
      code: sentinelCode,
      errorName: sentinelName,
      providerKind: 'openai'
    };
    const error = new ClassifiedProviderFailureError('provider_auth_failed', filterSafeClassificationDetails(rawInput));
    const serialized = JSON.stringify(error);
    expect(serialized).not.toContain('sk-test-secret');
    expect(serialized).not.toContain('/Users/mark/private');
    expect(serialized).not.toContain('authorization: Bearer');
    expect(serialized).not.toContain('sec_secret_handle_value');
    expect(error.failureReason).toBe('provider_auth_failed');
  });
});
