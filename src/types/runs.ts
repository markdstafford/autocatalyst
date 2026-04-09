// src/types/runs.ts

export type RunStage = 'intake' | 'speccing' | 'review' | 'approved' | 'failed';

export interface Run {
  id: string;
  idea_id: string;
  stage: RunStage;
  workspace_path: string;
  branch: string;
  spec_path: string | undefined;
  canvas_id: string | undefined;
  attempt: number;
  created_at: string; // ISO 8601
  updated_at: string; // ISO 8601
}
