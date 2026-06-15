import {
  ExecutionMaterializationError,
  ProviderConfigurationError,
  ProviderConnectionError,
  isClassifiedProviderFailureError,
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
  return undefined;
}
