import type { RunStage } from './runs.js';

export type Intent =
  | 'idea'
  | 'bug'
  | 'chore'
  | 'file_issues'
  | 'work_on_issue'
  | 'question'
  | 'feedback'
  | 'approval'
  | 'ignore'
  | string;

export type ClassificationContext = 'new_thread' | 'existing_issue' | RunStage | string;

export interface IntentClassifier {
  classify(message: string, context: ClassificationContext): Promise<Intent>;
}

export interface IntentDefinition {
  name: Intent;
  description: string;
  valid_contexts: ClassificationContext[];
  fallback_contexts?: ClassificationContext[];
}
