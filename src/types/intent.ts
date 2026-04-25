import type { RunStage } from './runs.js';

export type Intent =
  | 'idea'
  | 'bug'
  | 'chore'
  | 'file_issues'
  | 'question'
  | 'feedback'
  | 'approval'
  | 'ignore'
  | string;

export type ClassificationContext = 'new_thread' | RunStage | string;

export interface IntentClassifier {
  classify(message: string, context: ClassificationContext): Promise<Intent>;
}

export interface IntentDefinition {
  name: Intent;
  description: string;
  valid_contexts: ClassificationContext[];
  fallback_contexts?: ClassificationContext[];
}
