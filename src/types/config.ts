import { channelKey, type ChannelRegistry } from './channel.js';
import type { ArtifactLifecyclePolicy, ArtifactKind } from './artifact.js';
import type { AgentPluginConfig } from './ai.js';

// ─── AI config types ──────────────────────────────────────────────────────────

export type CredentialType = 'api_key' | 'iam' | 'workload_identity' | 'bearer_token';
export type EndpointProtocol = 'anthropic' | 'openai';
export type RunnerKind = 'anthropic_direct' | 'openai_direct' | 'claude_agent_sdk' | 'openai_agent_sdk';

export interface CredentialConfig {
  name: string;
  type: CredentialType;
  /** Value template with optional ${ENV_VAR} substitution. Used for api_key and bearer_token. */
  value?: string;
  /** Named AWS profile for IAM credentials. */
  aws_profile?: string;
  /** Workload identity federation fields. */
  federation_rule_id?: string;
  organization_id?: string;
  service_account_id?: string;
}

export interface EndpointConfig {
  name: string;
  protocol: EndpointProtocol;
  /** Reference to a CredentialConfig.name */
  credential: string;
  /** Optional base URL override */
  base_url?: string;
  /** Bedrock-specific region */
  region?: string;
}

export interface ProfileConfig {
  name: string;
  /** Reference to an EndpointConfig.name */
  endpoint: string;
  model: string;
  runner: RunnerKind;
  /** Anthropic-specific inference settings */
  anthropic?: {
    thinking?: 'adaptive' | 'disabled' | { type: 'enabled'; budget_tokens?: number };
    effort?: 'low' | 'medium' | 'high' | 'max';
  };
  /** OpenAI-specific inference settings */
  openai?: {
    reasoning_effort?: 'low' | 'medium' | 'high';
  };
  /** Optional plugins for agent runners */
  plugins?: AgentPluginConfig[];
}

/** Maps AgentTaskKind string keys to ProfileConfig.name values. */
export type RoutingConfig = Record<string, string>;

export interface AiConfig {
  credentials: CredentialConfig[];
  endpoints: EndpointConfig[];
  profiles: ProfileConfig[];
  routing: RoutingConfig;
}

// ─── Workflow config ──────────────────────────────────────────────────────────

export interface WorkflowChannelConfig {
  provider: string;
  name: string;
  workspace_root?: string;
  config?: Record<string, unknown>;
}

export interface WorkflowPublisherConfig {
  provider: string;
  artifacts?: string[];
  config?: Record<string, unknown>;
}

export interface TelemetryConfig {
  metrics_endpoint?: string;
  logs_endpoint?: string;
  export_interval_ms?: number;
}

export interface WorkflowConfig {
  polling?: {
    interval_ms?: number;
  };
  workspace?: {
    root?: string;
  };
  telemetry?: TelemetryConfig;
  channels?: WorkflowChannelConfig[];
  publishers?: WorkflowPublisherConfig[];
  artifact_policies?: Partial<Record<ArtifactKind, Partial<ArtifactLifecyclePolicy>>>;
  /** Required — declares all AI provider configuration. */
  ai: AiConfig;
  [key: string]: unknown;
}

export interface LoadedConfig {
  config: WorkflowConfig;
  filePath: string;
}

// ─── Repo map types ───────────────────────────────────────────────────────────

export interface RepoEntry {
  channel_ref: string;
  repo_url: string;
  workspace_root: string;
}

export type ChannelRepoMap = Map<string, RepoEntry>;

export function channelRegistryToRepoMap(registry: ChannelRegistry): ChannelRepoMap {
  const repoMap: ChannelRepoMap = new Map();
  for (const binding of registry.values()) {
    const key = channelKey(binding.channel);
    repoMap.set(key, {
      channel_ref: key,
      repo_url: binding.repo_url,
      workspace_root: binding.workspace_root,
    });
  }
  return repoMap;
}

export interface PreRepoEntry {
  channel_name: string;
  repo_url: string;
  workspace_root: string;
}
