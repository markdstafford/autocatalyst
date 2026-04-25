// src/types/runs.ts
import type { ChannelRef, ConversationRef, MessageRef } from './channel.js';
import type { Artifact } from './artifact.js';

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

export interface LastImplementationResult {
  summary: string;
  testing_instructions: string;
}

export interface Run {
  id: string;
  request_id: string;
  intent: RequestIntent;
  stage: RunStage;
  workspace_path: string;
  branch: string;
  artifact?: Artifact;
  impl_feedback_ref: string | undefined;
  issue: number | undefined;
  attempt: number;
  channel?: ChannelRef;
  conversation?: ConversationRef;
  origin?: MessageRef;
  pr_url: string | undefined;
  last_impl_result: LastImplementationResult | undefined;
  created_at: string;
  updated_at: string;
}
