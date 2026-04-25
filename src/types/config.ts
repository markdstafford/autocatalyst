export interface WorkflowConfig {
  polling?: {
    interval_ms?: number;
  };
  workspace?: {
    root?: string;
  };
  slack?: {
    bot_token?: string;
    app_token?: string;
    channel_name?: string;
    reacjis?: {
      ack?: string;
      complete?: string | null;
    };
  };
  notion?: {
    integration_token: string;
    specs_database_id: string;
    testing_guides_database_id: string;
  };
  aws_profile?: string;
  [key: string]: unknown;
}

export interface LoadedConfig {
  config: WorkflowConfig;
  promptTemplate: string;
  filePath: string;
}

/** A single repository entry resolved at startup for multi-repo routing. Internal use only. */
export interface RepoEntry {
  channel_id: string;      // resolved from WorkflowConfig.slack.channel_name at startup
  repo_url: string;        // from git remote get-url origin in the repo directory
  workspace_root: string;  // from WorkflowConfig or default (~/.autocatalyst/workspaces/)
}

/** Maps Slack channel_id → RepoEntry. Keyed by resolved channel_id. */
export type ChannelRepoMap = Map<string, RepoEntry>;

/** A pre-resolved entry used to configure multi-repo mode in SlackAdapter before channel IDs are known. */
export interface PreRepoEntry {
  channel_name: string;
  repo_url: string;
  workspace_root: string;
}
