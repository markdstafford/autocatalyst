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
    approval_emojis?: string[];
  };
  [key: string]: unknown;
}

export interface LoadedConfig {
  config: WorkflowConfig;
  promptTemplate: string;
  filePath: string;
}
