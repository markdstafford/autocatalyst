// src/types/runs.ts

export type RunStage =
  | 'intake'
  | 'speccing'
  | 'reviewing_spec'
  | 'implementing'
  | 'awaiting_impl_input'
  | 'reviewing_implementation'
  | 'done'
  | 'failed';

export type RequestIntent = 'idea' | 'bug' | 'question';

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
  attempt: number;
  channel_id: string;
  thread_ts: string;
  created_at: string; // ISO 8601
  updated_at: string; // ISO 8601
}
