export interface WorkflowConfig {
  polling?: {
    interval_ms?: number;
  };
  workspace?: {
    root?: string;
  };
  [key: string]: unknown;
}

export interface LoadedConfig {
  config: WorkflowConfig;
  promptTemplate: string;
  filePath: string;
}
