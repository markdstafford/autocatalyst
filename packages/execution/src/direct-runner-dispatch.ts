import type { z } from 'zod';
import type {
  AgentConnection,
  AgentConnectionTelemetryContext,
  ResolvedAgentCredentialReference,
  ResolvedAgentRunnerProfile
} from './agent-provider-adapter.js';
import { ProviderConfigurationError } from './agent-provider-adapter.js';
import type { DirectCallRequest, DirectProviderAdapter } from './direct-provider-adapter.js';
import { createDirectOrchestrator } from './direct-orchestrator.js';
import type { DirectOrchestratorCallResult, DirectOrchestratorTelemetryEmitter } from './direct-orchestrator.js';

/** Keyed by getDirectProviderAdapterKey(providerKind, adapterId) */
export type DirectProviderAdapterRegistry = ReadonlyMap<string, DirectProviderAdapter>;

export interface DirectProfileResolution {
  readonly profile: ResolvedAgentRunnerProfile;
  readonly credentialReference: ResolvedAgentCredentialReference;
}

export interface DirectCallFactoryInput<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  readonly runId: string;
  readonly tenant?: string;
  readonly phase?: string;
  readonly step: string;
  readonly directCall: DirectCallRequest<TSchema>;
}

export interface DirectCallFactory {
  call<TSchema extends z.ZodTypeAny>(input: DirectCallFactoryInput<TSchema>): Promise<DirectOrchestratorCallResult<z.infer<TSchema>>>;
}

export interface CreateDirectCallFactoryOptions {
  readonly adapters: Iterable<DirectProviderAdapter> | DirectProviderAdapterRegistry;
  readonly resolveProfile: (input: DirectCallFactoryInput) => Promise<DirectProfileResolution>;
  readonly createConnection: (
    input: DirectProfileResolution & { readonly telemetryContext: AgentConnectionTelemetryContext }
  ) => Promise<AgentConnection>;
  readonly telemetryContext?: (
    input: DirectCallFactoryInput,
    profile: ResolvedAgentRunnerProfile
  ) => AgentConnectionTelemetryContext;
  readonly telemetry?: DirectOrchestratorTelemetryEmitter;
}

export function getDirectProviderAdapterKey(providerKind: string, adapterId: string): string {
  return JSON.stringify([providerKind, adapterId]);
}

export function createDirectProviderAdapterRegistry(
  adapters: Iterable<DirectProviderAdapter>
): DirectProviderAdapterRegistry {
  const registry = new Map<string, DirectProviderAdapter>();
  for (const adapter of adapters) {
    const key = getDirectProviderAdapterKey(adapter.providerKind, adapter.adapterId);
    if (registry.has(key)) {
      throw new ProviderConfigurationError(
        'duplicate_adapter',
        `Duplicate direct adapter registered for ${adapter.providerKind}/${adapter.adapterId}.`,
        { providerKind: adapter.providerKind, adapterId: adapter.adapterId }
      );
    }
    registry.set(key, adapter);
  }
  return registry;
}

export function createDirectCallFactory(options: CreateDirectCallFactoryOptions): DirectCallFactory {
  const { resolveProfile, createConnection, telemetry } = options;

  // Build registry from iterable or use provided ReadonlyMap directly
  const registry: DirectProviderAdapterRegistry =
    options.adapters instanceof Map
      ? options.adapters
      : createDirectProviderAdapterRegistry(options.adapters as Iterable<DirectProviderAdapter>);

  return {
    async call<TSchema extends z.ZodTypeAny>(
      input: DirectCallFactoryInput<TSchema>
    ): Promise<DirectOrchestratorCallResult<z.infer<TSchema>>> {
      // Resolve profile
      const resolution = await resolveProfile(input);
      const { profile, credentialReference } = resolution;

      if (profile == null) {
        throw new ProviderConfigurationError(
          'missing_profile',
          `No direct profile resolved for step "${input.step}".`,
          { runId: input.runId, step: input.step }
        );
      }

      // Validate direct mode
      if (profile.mode !== 'direct') {
        throw new ProviderConfigurationError(
          'mechanism_mismatch',
          `Profile for step "${input.step}" is not a direct profile (mode: ${profile.mode}).`,
          { runId: input.runId, step: input.step, mode: profile.mode }
        );
      }

      // Look up adapter
      const adapterKey = getDirectProviderAdapterKey(profile.providerKind, profile.adapterId);
      const adapter = registry.get(adapterKey);

      if (adapter === undefined) {
        throw new ProviderConfigurationError(
          'unsupported_adapter',
          `No direct adapter registered for providerKind "${profile.providerKind}" and adapterId "${profile.adapterId}".`,
          { providerKind: profile.providerKind, adapterId: profile.adapterId }
        );
      }

      // Build telemetry context (no role for direct calls)
      const telemetryContext: AgentConnectionTelemetryContext =
        options.telemetryContext !== undefined
          ? options.telemetryContext(input, profile)
          : {
              runId: input.runId,
              step: input.step,
              ...(input.phase !== undefined && { phase: input.phase }),
              ...(profile.profileName !== undefined && { profileName: profile.profileName }),
              ...(profile.configurationRecordId !== undefined && { configurationRecordId: profile.configurationRecordId })
              // No role field for direct calls
            };

      // Create connection
      const connection = await createConnection({ profile, credentialReference, telemetryContext });

      // Create orchestrator and call
      const orchestrator = createDirectOrchestrator({
        adapter,
        profile,
        connection,
        telemetryContext,
        ...(telemetry !== undefined && { telemetry })
      });

      return orchestrator.call(input.directCall);
    }
  };
}
