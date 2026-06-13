import type {
  AgentConnection,
  AgentConnectionTelemetryContext,
  ProcessLaunchConfig,
  ProcessLaunchConfigInput,
  ProviderFetchTransport,
  ResolvedAgentCredentialReference,
  ResolvedAgentRunnerProfile
} from './agent-provider-adapter.js';
import {
  ProviderConfigurationError,
  ProviderConnectionError
} from './agent-provider-adapter.js';
import { ClassifiedProviderFailureError } from './errors.js';
import { classifyProviderFailure } from './failure-reasons.js';
import type { ProviderRequest } from './request-alteration.js';
import {
  applyRequestAlteration,
  buildClaudeProcessLaunchEnvironment,
  isTransientProviderFailure,
  redactProcessLaunchConfigForLog,
  redactProviderRequestForLog,
  redactProviderResponseForLog
} from './request-alteration.js';

// Re-export the types that callers expect from connection.ts
export type { AgentConnection, ProcessLaunchConfig, ProcessLaunchConfigInput, ProviderFetchTransport };

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface ProviderCredentialResolver {
  resolveCredential(secretHandle: string): Promise<string | undefined>;
}

export interface ProviderConnectionLogger {
  info(event: string, fields: unknown): void;
  warn(event: string, fields: unknown): void;
  error(event: string, fields: unknown): void;
}

export interface AgentConnectionFactoryOptions {
  readonly profile: ResolvedAgentRunnerProfile;
  readonly credentialReference: ResolvedAgentCredentialReference;
  readonly credentialResolver: ProviderCredentialResolver;
  readonly telemetryContext: AgentConnectionTelemetryContext;
  readonly logger?: ProviderConnectionLogger;
  readonly fetch?: typeof globalThis.fetch;
}

// ---------------------------------------------------------------------------
// createAgentConnection
// ---------------------------------------------------------------------------

export async function createAgentConnection(
  options: AgentConnectionFactoryOptions
): Promise<AgentConnection> {
  const {
    profile,
    credentialReference,
    credentialResolver,
    telemetryContext,
    logger,
    fetch: fetchImpl = globalThis.fetch
  } = options;

  // ------------------------------------------------------------------
  // Credential resolution (eager, at factory time)
  // ------------------------------------------------------------------
  let resolvedCredential: string | undefined;

  if (credentialReference.secretHandle !== undefined) {
    try {
      resolvedCredential = await credentialResolver.resolveCredential(credentialReference.secretHandle);
    } catch {
      throw new ProviderConfigurationError(
        'secret_store_locked',
        'The credential store is locked or unavailable.',
        { providerKind: profile.providerKind, profileName: profile.profileName }
      );
    }
  }

  if (credentialReference.required && resolvedCredential === undefined) {
    throw new ClassifiedProviderFailureError('provider_auth_failed', {
      providerKind: profile.providerKind,
      errorName: 'MissingCredential'
    });
  }

  const credentialResolved = resolvedCredential !== undefined;

  // ------------------------------------------------------------------
  // Eager endpoint validation for fetch_transport profiles
  // ------------------------------------------------------------------
  if (profile.connectionMechanism === 'fetch_transport' && profile.endpoint.baseUrl) {
    try {
      new URL(profile.endpoint.baseUrl);
    } catch {
      throw new ProviderConfigurationError('invalid_endpoint', `Invalid endpoint baseUrl: ${profile.endpoint.baseUrl}`);
    }
  }

  // ------------------------------------------------------------------
  // Shared safe log context (telemetry, no secrets)
  // ------------------------------------------------------------------
  const safeLogContext = {
    runId: telemetryContext.runId,
    phase: telemetryContext.phase,
    step: telemetryContext.step,
    role: telemetryContext.role,
    configurationRecordId: telemetryContext.configurationRecordId,
    provider: profile.providerKind,
    model: profile.model.model,
    mechanism: profile.connectionMechanism,
    profileName: profile.profileName
  };

  // ------------------------------------------------------------------
  // Return AgentConnection handle — credential stays in closure
  // ------------------------------------------------------------------

  return {
    profile,
    credentialResolved,

    // ----------------------------------------------------------------
    // createFetchTransport
    // ----------------------------------------------------------------
    createFetchTransport(): ProviderFetchTransport {
      if (profile.connectionMechanism !== 'fetch_transport') {
        throw new ProviderConnectionError(
          'unsupported_connection_mechanism',
          `createFetchTransport() is not supported for mechanism "${profile.connectionMechanism}".`,
          { mechanism: profile.connectionMechanism }
        );
      }

      return {
        async fetch(request: ProviderRequest): Promise<Response> {
          const altered = applyRequestAlteration({
            request,
            endpoint: profile.endpoint,
            ...(resolvedCredential !== undefined && { credential: resolvedCredential }),
            authScheme: 'raw'
          });

          const { maxRetries } = altered.retryPolicy;
          let attemptNumber = 0;
          let lastStatus: number | undefined;

          while (attemptNumber <= maxRetries) {
            const attemptStart = Date.now();
            attemptNumber++;

            let response: Response | undefined;
            let transportError: unknown;

            try {
              const ctrl = new AbortController();
              const timeoutId = setTimeout(() => ctrl.abort(), altered.timeoutMs);

              const fetchHeaders = altered.request.headers as Record<string, string>;
              // ProviderRequest.body is fetch-style BodyInit — already serialized when string.
              // Only stringify non-string objects; pass strings and other BodyInit values through.
              const rawBody = altered.request.body;
              const body = rawBody !== undefined
                ? (typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody))
                : undefined;

              response = await fetchImpl(altered.request.url, {
                method: altered.request.method,
                headers: fetchHeaders,
                ...(body !== undefined && { body }),
                signal: ctrl.signal
              });

              clearTimeout(timeoutId);
            } catch (err) {
              transportError = err;
            }

            const durationMs = Date.now() - attemptStart;

            if (transportError !== undefined) {
              // Transport error — always transient
              if (logger) {
                logger.warn('provider.fetch.attempt', {
                  ...safeLogContext,
                  attemptNumber,
                  durationMs,
                  outcome: 'transport_error'
                });
              }

              if (attemptNumber > maxRetries) {
                throw new ProviderConnectionError(
                  'retry_exhausted',
                  `Provider request failed after ${maxRetries} retries (transport error).`,
                  { ...safeLogContext, attempts: attemptNumber }
                );
              }
              continue;
            }

            const status = response!.status;
            lastStatus = status;

            const isTransient = isTransientProviderFailure({ kind: 'http_status', status });
            const isSuccess = status >= 200 && status < 300;

            const redactedReq = redactProviderRequestForLog({
              request: altered.request,
              knownSecretValues: resolvedCredential ? [resolvedCredential] : []
            });
            const redactedResp = redactProviderResponseForLog({
              statusCode: status,
              knownSecretValues: resolvedCredential ? [resolvedCredential] : []
            });

            if (isSuccess) {
              if (logger) {
                logger.info('provider.fetch.attempt', {
                  ...safeLogContext,
                  attemptNumber,
                  statusCode: status,
                  durationMs,
                  outcome: 'success',
                  request: redactedReq,
                  response: redactedResp
                });
              }
              return response!;
            }

            if (isTransient) {
              if (logger) {
                logger.warn('provider.fetch.attempt', {
                  ...safeLogContext,
                  attemptNumber,
                  statusCode: status,
                  durationMs,
                  outcome: 'transient_failure',
                  request: redactedReq,
                  response: redactedResp
                });
              }

              if (attemptNumber > maxRetries) {
                throw new ProviderConnectionError(
                  'retry_exhausted',
                  `Provider request failed after ${maxRetries} retries (last status: ${status}).`,
                  { ...safeLogContext, attempts: attemptNumber, lastStatusCode: status }
                );
              }
              continue;
            }

            // Non-transient failure — do not retry, do not leak body
            const classifiedReason = classifyProviderFailure({
              status,
              providerKind: profile.providerKind
            });

            if (classifiedReason !== undefined) {
              if (logger) {
                logger.error('provider.fetch.attempt', {
                  ...safeLogContext,
                  attemptNumber,
                  statusCode: status,
                  durationMs,
                  outcome: 'classified_provider_failure',
                  failureReason: classifiedReason,
                  request: redactedReq,
                  response: redactedResp
                });
              }
              throw new ClassifiedProviderFailureError(classifiedReason, {
                providerKind: profile.providerKind,
                statusCode: status
              });
            }

            if (logger) {
              logger.error('provider.fetch.attempt', {
                ...safeLogContext,
                attemptNumber,
                statusCode: status,
                durationMs,
                outcome: 'non_transient_failure',
                request: redactedReq,
                response: redactedResp
              });
            }

            throw new ProviderConnectionError(
              'non_transient_provider_failure',
              `Provider returned non-transient failure (status: ${status}).`,
              { ...safeLogContext, statusCode: status }
            );
          }

          // Should not be reachable — safety net
          throw new ProviderConnectionError(
            'retry_exhausted',
            `Provider request failed after ${maxRetries} retries (status: ${lastStatus ?? 'unknown'}).`,
            { ...safeLogContext, attempts: attemptNumber, lastStatusCode: lastStatus }
          );
        }
      };
    },

    // ----------------------------------------------------------------
    // createProcessLaunchConfig
    // ----------------------------------------------------------------
    createProcessLaunchConfig(input: ProcessLaunchConfigInput): ProcessLaunchConfig {
      if (profile.connectionMechanism !== 'process_environment') {
        throw new ProviderConnectionError(
          'unsupported_connection_mechanism',
          `createProcessLaunchConfig() is not supported for mechanism "${profile.connectionMechanism}".`,
          { mechanism: profile.connectionMechanism }
        );
      }

      const credential = resolvedCredential ?? '';

      const launchResult = buildClaudeProcessLaunchEnvironment({
        endpoint: profile.endpoint,
        credential,
        materializedEnvironment: input.materializedEnvironment
      });

      const redacted = redactProcessLaunchConfigForLog({
        launchResult,
        knownSecretValues: resolvedCredential ? [resolvedCredential] : [],
        additionalMeta: safeLogContext
      });

      if (logger) {
        logger.info('provider.launch.config', {
          ...safeLogContext,
          launchConfig: redacted
        });
      }

      return {
        environment: launchResult.environment,
        secretVariableNames: launchResult.secretVariableNames,
        degradedCapabilities: launchResult.degradedCapabilities,
        redacted
      };
    }
  };
}
