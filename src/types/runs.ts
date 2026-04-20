// src/types/runs.ts

export type RunStage =
  | 'intake'
  | 'speccing'
  | 'reviewing_spec'
  | 'implementing'
  | 'awaiting_impl_input'
  | 'reviewing_implementation'
  | 'pr_open'              // new: PR created, awaiting merge signal
  | 'done'
  | 'failed';

export type RequestIntent = 'idea' | 'bug' | 'chore' | 'file_issues' | 'question';

export interface Run {
  id: string;
  request_id: string;
  intent: RequestIntent;
  stage: RunStage;
  workspace_path: string;
  branch: string;
  spec_path: string | undefined;
  publisher_ref: string | undefined; // Notion page ID or Slack canvas ID
  impl_feedback_ref: string | undefined; // Notion page ID for implementation feedback
  issue: number | undefined; // GitHub issue number (bug and chore runs)
  attempt: number;
  channel_id: string;
  thread_ts: string;
  pr_url: string | undefined;          // new: PR URL set after PR creation
  last_impl_result: {                  // new: set after implementation completes
    summary: string;
    testing_instructions: string;
  } | undefined;
  created_at: string; // ISO 8601
  updated_at: string; // ISO 8601
}
