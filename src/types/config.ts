import { channelKey, type ChannelRegistry } from './channel.js';
import type { ArtifactLifecyclePolicy, ArtifactKind } from './artifact.js';

export type ModelProvider = 'anthropic' | 'bedrock';
export type AnthropicAuthMethod = 'api_key' | 'sso';
export type BedrockAuthMethod = 'iam';
export type AuthMethod = AnthropicAuthMethod | BedrockAuthMethod;

/**
 * Identifies which SSO provider's OAuth flow to initiate when auth=sso.
 * Distinct from ModelProvider — the SSO provider is the identity/credential source,
 * not necessarily the model inference backend.
 * Extend this union as additional SSO providers are supported (e.g. 'codex').
 */
export type SsoProvider = 'anthropic';

export interface LlmSettings {
  provider: ModelProvider;
  /**
   * Authentication method.
   * - For provider "anthropic": "api_key" (default) or "sso"
   * - For provider "bedrock": "iam" (default, only valid value)
   * Optional — defaults are applied in resolveLlmSettings.
   */
  auth?: AuthMethod;
  /**
   * AWS named profile to use for Bedrock authentication.
   * Ignored when provider is not "bedrock".
   */
  aws_profile?: string;
}

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

export interface WorkflowConfig {
  polling?: {
    interval_ms?: number;
  };
  workspace?: {
    root?: string;
  };
  channels?: WorkflowChannelConfig[];
  publishers?: WorkflowPublisherConfig[];
  artifact_policies?: Partial<Record<ArtifactKind, Partial<ArtifactLifecyclePolicy>>>;
  /** Required — declares the AI provider and authentication method. */
  llm_settings: LlmSettings;
  [key: string]: unknown;
}

export interface LoadedConfig {
  config: WorkflowConfig;
  promptTemplate: string;
  filePath: string;
}

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
