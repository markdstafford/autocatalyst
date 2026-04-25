import { channelKey, type ChannelRegistry } from './channel.js';
import type { ArtifactLifecyclePolicy, ArtifactKind } from './artifact.js';

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
  aws_profile?: string;
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
