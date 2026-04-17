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
