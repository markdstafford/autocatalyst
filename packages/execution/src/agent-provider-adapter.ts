import type { InferenceSettings, JsonValue, ModelIdentity, RunnerEndpointSettings, TokenBreakdown } from '@autocatalyst/api-contract';
import type { RunnerEvent } from '@autocatalyst/api-contract';

import type { RunnerRunInput } from './runner.js';
import type { ProviderCapabilityDegradation, ProviderRequest } from './request-alteration.js';
import type { StructuredAgentResultCapture } from './structured-result-capture.js';
import type { AgentModelMemoryContinuity } from './agent-model-memory.js';

export type ProviderConnectionMechanism = 'fetch_transport' | 'process_environment';

export type RunnerProfileMode = 'agent' | 'direct';

// The same profile shape that model routing (issue #29) will later resolve to
export interface ResolvedAgentRunnerProfile {
  readonly mode: RunnerProfileMode;
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

// ---------------------------------------------------------------------------
// Connection handle types (defined here; connection.ts imports from here)
// ---------------------------------------------------------------------------

export interface ProviderFetchTransport {
  fetch(request: ProviderRequest): Promise<Response>;
}

export interface ProcessLaunchConfigInput {
  readonly materializedEnvironment: {
    readonly variables: Readonly<Record<string, string>>;
    readonly secretVariableNames: readonly string[];
  };
}

export interface ProcessLaunchConfig {
  readonly environment: Readonly<Record<string, string>>;
  readonly secretVariableNames: readonly string[];
  readonly degradedCapabilities: readonly ProviderCapabilityDegradation[];
  readonly redacted: JsonValue;
}

// Full AgentConnection interface
export interface AgentConnection {
  readonly profile: ResolvedAgentRunnerProfile;
  readonly credentialResolved: boolean;
  createFetchTransport(): ProviderFetchTransport;
  createProcessLaunchConfig(input: ProcessLaunchConfigInput): ProcessLaunchConfig | Promise<ProcessLaunchConfig>;
  close?(): Promise<void>;
}

export interface AgentProviderSessionInput {
  readonly runInput: RunnerRunInput;
  readonly profile: ResolvedAgentRunnerProfile;
  readonly connection: AgentConnection;
  readonly telemetryContext: AgentConnectionTelemetryContext;
  readonly structuredResultCapture?: StructuredAgentResultCapture;
  readonly modelMemory?: AgentModelMemoryContinuity;
}

export interface AgentTokenUsage {
  readonly available: boolean;
  readonly tokens?: TokenBreakdown;
}

export interface AgentProviderSessionMetadata {
  readonly outcome: 'succeeded' | 'failed' | 'canceled';
  readonly launchMechanism: ProviderConnectionMechanism;
  readonly degradedCapabilities: readonly ProviderCapabilityDegradation[];
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
  | 'duplicate_adapter'
  | 'invalid_endpoint'
  | 'mechanism_mismatch'
  | 'unsupported_required_capability';

export type ProviderConnectionErrorCode =
  | 'unsupported_connection_mechanism'
  | 'timeout'
  | 'retry_exhausted'
  | 'transient_provider_failure'
  | 'non_transient_provider_failure'
  | 'process_launch_failed';

export type ProviderProtocolErrorCode =
  | 'event_mapping_failed'
  | 'invalid_provider_event'
  | 'impossible_session_sequence'
  | 'missing_structured_result'
  | 'duplicate_structured_result'
  | 'structured_result_invalid';

export type UnsupportedProviderCapabilityErrorCode =
  | 'inference_setting_unsupported'
  | 'tool_policy_unsupported'
  | 'skill_unsupported'
  | 'header_operation_unsupported'
  | 'sandbox_client_unsupported'
  | 'sandbox_snapshot_unsupported'
  | 'workspace_containment_violation'
  | 'structured_result_unsupported';

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
