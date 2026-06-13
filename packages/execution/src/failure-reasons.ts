export const knownFailureReasonCodes = [
  'provider_auth_failed',
  'spec_authoring_failed',
  'auto_dispatch_failed',
  'runner_failed_before_terminal_result',
  'workspace_provisioning_failed',
  'result_file_missing',
  'schema_validation_failed'
] as const;

export type KnownFailureReasonCode = typeof knownFailureReasonCodes[number];

export const knownSafeFailurePhrases = [
  'Runner failed before terminal result.',
  'Execution failed: workspace_provisioning_failed',
  'Execution failed: result_file_missing',
  'Execution failed: result_file_unreadable',
  'Execution failed: result_json_invalid',
  'Execution failed: result_path_outside_scratch_root',
  'Execution failed: result_contract_missing',
  'Execution failed: result_contract_unknown',
  'Execution failed: schema_validation_failed',
  'Execution failed: correction_attempts_exhausted',
  'Execution failed: correction_request_failed',
  'Execution failed: normalizer_failed',
  'Execution failed: direct_port_not_configured',
  'Execution failed: direct_call_failed',
  'Execution failed: unsupported_adapter',
  'Execution failed: missing_candidate',
  'Execution failed: invalid_direct_metadata',
  'Execution failed: structured_result_missing',
  'Execution failed: structured_result_malformed',
  'Execution failed: multiple_structured_candidates',
  'Execution failed: extra_structured_output'
] as const;

export type KnownSafeFailurePhrase = typeof knownSafeFailurePhrases[number];
export type SanitizedFailureReason = KnownFailureReasonCode | KnownSafeFailurePhrase;

const knownFailureReasonCodeSet = new Set<string>(knownFailureReasonCodes);
const knownSafeFailurePhraseSet = new Set<string>(knownSafeFailurePhrases);

const authCodes = new Set([
  'auth_failed',
  'authentication_error',
  'authentication_failed',
  'invalid_api_key',
  'invalid_api_key_error',
  'invalid_auth',
  'invalid_request_error_auth',
  'unauthorized',
  'unauthenticated',
  'permission_denied'
]);

const authErrorNames = new Set([
  'AuthenticationError',
  'APIAuthenticationError',
  'UnauthorizedError',
  'PermissionDeniedError',
  'InvalidApiKeyError'
]);

export interface ProviderFailureClassificationInput {
  readonly status?: number;
  readonly statusCode?: number;
  readonly code?: unknown;
  readonly errorName?: unknown;
  readonly providerKind?: string;
}

export function makeSanitizedFailureReason(value: unknown): SanitizedFailureReason | undefined {
  if (typeof value !== 'string') return undefined;
  if (knownFailureReasonCodeSet.has(value)) return value as SanitizedFailureReason;
  if (knownSafeFailurePhraseSet.has(value)) return value as SanitizedFailureReason;
  return undefined;
}

export function normalizeFailureReasonForPublicSurface(value: unknown): SanitizedFailureReason | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return makeSanitizedFailureReason(value) ?? 'runner_failed_before_terminal_result';
}

export function formatExecutionFailureReason(code: string): SanitizedFailureReason {
  if (code === 'provider_auth_failed') return 'provider_auth_failed';
  const direct = makeSanitizedFailureReason(code);
  if (direct !== undefined && knownFailureReasonCodeSet.has(direct)) return direct;
  const phrase = `Execution failed: ${code}`;
  return makeSanitizedFailureReason(phrase) ?? 'runner_failed_before_terminal_result';
}

export function classifyProviderFailure(input: ProviderFailureClassificationInput): KnownFailureReasonCode | undefined {
  const status = input.status ?? input.statusCode;
  if (status === 401) return 'provider_auth_failed';

  const code = typeof input.code === 'string' ? input.code : undefined;
  if (code !== undefined && authCodes.has(code.toLowerCase())) return 'provider_auth_failed';

  const errorName = typeof input.errorName === 'string' ? input.errorName : undefined;
  if (errorName !== undefined && authErrorNames.has(errorName)) return 'provider_auth_failed';

  return undefined;
}

/**
 * Returns a safe subset of classification inputs for use as safeDetails.
 * Strips code/errorName unless they are in the auth allowlists so that
 * arbitrary SDK-provided strings (tokens, paths, response bodies) cannot
 * reach serialized error objects.
 */
export function filterSafeClassificationDetails(input: ProviderFailureClassificationInput): ProviderFailureClassificationInput {
  const safe: ProviderFailureClassificationInput = {};
  if (typeof input.status === 'number') (safe as Record<string, unknown>)['status'] = input.status;
  if (typeof input.statusCode === 'number') (safe as Record<string, unknown>)['statusCode'] = input.statusCode;
  if (typeof input.providerKind === 'string') (safe as Record<string, unknown>)['providerKind'] = input.providerKind;
  const code = typeof input.code === 'string' ? input.code : undefined;
  if (code !== undefined && authCodes.has(code.toLowerCase())) (safe as Record<string, unknown>)['code'] = code;
  const errorName = typeof input.errorName === 'string' ? input.errorName : undefined;
  if (errorName !== undefined && authErrorNames.has(errorName)) (safe as Record<string, unknown>)['errorName'] = errorName;
  return safe;
}
