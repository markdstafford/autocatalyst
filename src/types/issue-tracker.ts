import type { RequestIntent } from './runs.js';

export interface IssueManager {
  writeIssue(workspace_path: string, issue_number: number, body: string): Promise<void>;
  create(workspace_path: string, title: string, body: string, labels?: string[]): Promise<{ number: number }>;
}

export interface PRManagerOptions {
  impl_result?: {
    summary: string;
    testing_instructions: string;
  };
  run_intent?: RequestIntent;
}

export interface PRManager {
  createPR(
    workspace_path: string,
    branch: string,
    artifact_path: string,
    options?: PRManagerOptions,
  ): Promise<string>;

  mergePR(
    workspace_path: string,
    pr_url: string,
  ): Promise<void>;
}
