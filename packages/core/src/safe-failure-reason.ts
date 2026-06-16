import {
  ExecutionMaterializationError,
  ProviderConfigurationError,
  ProviderConnectionError,
  isClassifiedProviderFailureError,
  classifyProviderFailure,
  formatExecutionFailureReason,
  makeSanitizedFailureReason,
  type SanitizedFailureReason
} from '@autocatalyst/execution';
import { ModelRoutingConfigurationError } from './model-routing-resolver.js';

export function safeFailureReasonFromError(error: unknown): SanitizedFailureReason | undefined {
  if (isClassifiedProviderFailureError(error)) {
    return error.failureReason;
  }
  if (error instanceof ModelRoutingConfigurationError) {
    return makeSanitizedFailureReason(error.code);
  }
  if (error instanceof ProviderConfigurationError) {
    return makeSanitizedFailureReason(error.code) ?? formatExecutionFailureReason(error.code);
  }
  if (error instanceof ProviderConnectionError) {
    return makeSanitizedFailureReason(error.code) ?? formatExecutionFailureReason(error.code);
  }
  if (error instanceof ExecutionMaterializationError) {
    return formatExecutionFailureReason(error.code);
  }
  const shaped = error as { status?: unknown; statusCode?: unknown; code?: unknown; name?: unknown };
  const classified = classifyProviderFailure({
    ...(typeof shaped.status === 'number' ? { status: shaped.status } : {}),
    ...(typeof shaped.statusCode === 'number' ? { statusCode: shaped.statusCode } : {}),
    code: shaped.code,
    errorName: shaped.name
  });
  if (classified !== undefined) {
    return classified;
  }
  return undefined;
}
