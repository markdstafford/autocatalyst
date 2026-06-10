import type {
  AgentConnection,
  AgentConnectionTelemetryContext,
  AgentProviderAdapter,
  ResolvedAgentCredentialReference,
  ResolvedAgentRunnerProfile
} from './agent-provider-adapter.js';
import { ProviderConfigurationError } from './agent-provider-adapter.js';
import { createAgentOrchestratorRunner } from './agent-orchestrator-runner.js';
import type { Runner } from './runner.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Keyed by getAgentProviderAdapterKey(providerKind, adapterId) */
export type AgentProviderAdapterRegistry = ReadonlyMap<string, AgentProviderAdapter>;

export interface AgentProfileResolution {
  readonly profile: ResolvedAgentRunnerProfile;
  readonly credentialReference: ResolvedAgentCredentialReference;
}

export interface AgentRunnerFactoryInput {
  readonly runId: string;
  readonly phase?: string;
  readonly step: string;
  readonly role?: string;
}

export interface AgentRunnerFactory {
  createRunner(input: AgentRunnerFactoryInput): Promise<Runner>;
}

export interface CreateAgentRunnerFactoryOptions {
  readonly adapters: AgentProviderAdapterRegistry;
  readonly resolveProfile: (input: AgentRunnerFactoryInput) => Promise<AgentProfileResolution>;
  readonly createConnection: (
    input: AgentProfileResolution & { readonly telemetryContext: AgentConnectionTelemetryContext }
  ) => Promise<AgentConnection>;
  readonly telemetryContext?: (input: AgentRunnerFactoryInput) => AgentConnectionTelemetryContext;
}

// ---------------------------------------------------------------------------
// Key builder
// ---------------------------------------------------------------------------

export function getAgentProviderAdapterKey(providerKind: string, adapterId: string): string {
  return JSON.stringify([providerKind, adapterId]);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAgentRunnerFactory(options: CreateAgentRunnerFactoryOptions): AgentRunnerFactory {
  const { adapters, resolveProfile, createConnection, telemetryContext: telemetryContextFn } = options;

  return {
    async createRunner(input: AgentRunnerFactoryInput): Promise<Runner> {
      // Step a: resolve profile
      const resolution = await resolveProfile(input);
      const { profile, credentialReference } = resolution;

      // Step a (validation): ensure profile is present
      if (profile == null) {
        throw new ProviderConfigurationError(
          'missing_profile',
          `No runner profile resolved for step "${input.step}".`,
          { runId: input.runId, step: input.step }
        );
      }

      // Step b: build telemetry context
      const telemetryContext: AgentConnectionTelemetryContext =
        telemetryContextFn !== undefined
          ? telemetryContextFn(input)
          : {
              runId: input.runId,
              phase: input.phase,
              step: input.step,
              role: input.role,
              profileName: profile.profileName,
              configurationRecordId: profile.configurationRecordId
            };

      // Step c: look up adapter
      const adapterKey = getAgentProviderAdapterKey(profile.providerKind, profile.adapterId);
      const adapter = adapters.get(adapterKey);

      if (adapter === undefined) {
        throw new ProviderConfigurationError(
          'unsupported_adapter',
          `No adapter registered for providerKind "${profile.providerKind}" and adapterId "${profile.adapterId}".`,
          { providerKind: profile.providerKind, adapterId: profile.adapterId }
        );
      }

      // Step d: validate providerKind match
      if (profile.providerKind !== adapter.providerKind) {
        throw new ProviderConfigurationError(
          'mechanism_mismatch',
          `Profile providerKind "${profile.providerKind}" does not match adapter providerKind "${adapter.providerKind}".`,
          { profileProviderKind: profile.providerKind, adapterProviderKind: adapter.providerKind }
        );
      }

      // Step e: validate connectionMechanism match
      if (profile.connectionMechanism !== adapter.supportedConnectionMechanism) {
        throw new ProviderConfigurationError(
          'mechanism_mismatch',
          `Profile connectionMechanism "${profile.connectionMechanism}" does not match adapter supportedConnectionMechanism "${adapter.supportedConnectionMechanism}".`,
          {
            profileConnectionMechanism: profile.connectionMechanism,
            adapterSupportedConnectionMechanism: adapter.supportedConnectionMechanism
          }
        );
      }

      // Step f: create connection
      const connection = await createConnection({ profile, credentialReference, telemetryContext });

      // Step g: return orchestrator runner
      return createAgentOrchestratorRunner({ adapter, profile, connection, telemetryContext });
    }
  };
}
