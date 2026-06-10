import type { InferenceSettings, ModelIdentity, RunnerEndpointSettings, TokenBreakdown } from '@autocatalyst/api-contract';
import type { RunnerEvent } from '@autocatalyst/api-contract';

import type { RunnerRunInput } from './runner.js';

export type ProviderConnectionMechanism = 'fetch_transport' | 'process_environment';

// The same profile shape that model routing (issue #29) will later resolve to
export interface ResolvedAgentRunnerProfile {
  readonly providerKind: string;
  readonly adapterId: string;
  readonly profileName: string;
  readonly configurationRecordId?: string;
  readonly model: ModelIdentity;
  readonly inferenceSettings: InferenceSettings;
  readonly endpoint: RunnerEndpointSettings;
  readonly connectionMechanism: ProviderConnectionMechanism;
}

// Connection-factory-only input — adapters, logs, and telemetry receive only the profile and AgentConnection
export interface ResolvedAgentCredentialReference {
  readonly required: boolean;
  readonly secretHandle?: string;
  readonly authTarget?: 'header' | 'process_environment';
}

export interface AgentConnectionTelemetryContext {
  readonly runId: string;
  readonly phase?: string;
  readonly step: string;
  readonly role?: string;
  readonly profileName?: string;
  readonly configurationRecordId?: string;
}

// Minimal AgentConnection interface here; connection.ts will expand/re-export
export interface AgentConnection {
  readonly profile: ResolvedAgentRunnerProfile;
  readonly credentialResolved: boolean;
}

export interface AgentProviderSessionInput {
  readonly runInput: RunnerRunInput;
  readonly profile: ResolvedAgentRunnerProfile;
  readonly connection: AgentConnection;
  readonly telemetryContext: AgentConnectionTelemetryContext;
}

export interface AgentTokenUsage {
  readonly available: boolean;
  readonly tokens?: TokenBreakdown;
}

export interface AgentProviderSessionMetadata {
  readonly outcome: 'succeeded' | 'failed' | 'canceled';
  readonly launchMechanism: ProviderConnectionMechanism;
  readonly degradedCapabilities: readonly import('./request-alteration.js').ProviderCapabilityDegradation[];
  readonly tokenUsage: AgentTokenUsage;
  readonly model?: ModelIdentity;
}

export interface AgentProviderSession {
  readonly events: AsyncIterable<RunnerEvent>;
  readonly metadata: Promise<AgentProviderSessionMetadata>;
  close?(): Promise<void>;
}

export interface AgentProviderAdapter {
  readonly providerKind: string;
  readonly adapterId: string;
  readonly supportedConnectionMechanism: ProviderConnectionMechanism;
  startSession(input: AgentProviderSessionInput): AgentProviderSession | Promise<AgentProviderSession>;
  close?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Sanitized error types — never include raw upstream request/response/transcript/launch env/secret text
// ---------------------------------------------------------------------------

export type ProviderConfigurationErrorCode =
  | 'missing_profile'
  | 'missing_credential'
  | 'secret_store_locked'
  | 'unsupported_adapter'
  | 'invalid_endpoint'
  | 'mechanism_mismatch'
  | 'unsupported_required_capability';

export type ProviderConnectionErrorCode =
  | 'unsupported_connection_mechanism'
  | 'timeout'
  | 'retry_exhausted'
  | 'non_transient_provider_failure'
  | 'process_launch_failed';

export type ProviderProtocolErrorCode =
  | 'event_mapping_failed'
  | 'invalid_provider_event'
  | 'impossible_session_sequence';

export type UnsupportedProviderCapabilityErrorCode =
  | 'inference_setting_unsupported'
  | 'tool_policy_unsupported'
  | 'skill_unsupported'
  | 'header_operation_unsupported';

export class ProviderConfigurationError extends Error {
  constructor(
    public readonly code: ProviderConfigurationErrorCode,
    message: string,
    public readonly safeDetails?: unknown
  ) {
    super(message);
    this.name = 'ProviderConfigurationError';
  }
}

export class ProviderConnectionError extends Error {
  constructor(
    public readonly code: ProviderConnectionErrorCode,
    message: string,
    public readonly safeDetails?: unknown
  ) {
    super(message);
    this.name = 'ProviderConnectionError';
  }
}

export class ProviderProtocolError extends Error {
  constructor(
    public readonly code: ProviderProtocolErrorCode,
    message: string,
    public readonly safeDetails?: unknown
  ) {
    super(message);
    this.name = 'ProviderProtocolError';
  }
}

export class UnsupportedProviderCapabilityError extends Error {
  constructor(
    public readonly code: UnsupportedProviderCapabilityErrorCode,
    message: string,
    public readonly safeDetails?: unknown
  ) {
    super(message);
    this.name = 'UnsupportedProviderCapabilityError';
  }
}
