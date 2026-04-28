import type { ClassificationContext, Intent, IntentClassifier } from './intent.js';
import type { Request, ThreadMessage } from './events.js';
import type { ArtifactKind } from './artifact.js';
import type { RunStage } from './runs.js';

export type AgentTaskKind =
  | 'intent.classify'
  | 'artifact.create'
  | 'artifact.revise'
  | 'implementation.run'
  | 'question.answer'
  | 'issue.triage'
  | 'pr.title_generate';

export interface AgentRoute {
  task: AgentTaskKind;
  stage?: RunStage | 'new_thread' | string;
  intent?: Intent;
  artifact_kind?: ArtifactKind;
}

export type AgentEffort = 'low' | 'medium' | 'high' | 'max';
export type AgentSettingSource = 'user' | 'project' | 'local';

export type AgentThinking =
  | 'adaptive'
  | 'disabled'
  | { type: 'enabled'; budget_tokens?: number };

export interface AgentPluginConfig {
  type: 'local';
  path: string;
}

export interface AgentProfile {
  id: string;
  provider: string;
  model?: string;
  effort?: AgentEffort;
  thinking?: AgentThinking;
  setting_sources?: AgentSettingSource[];
  load_user_settings?: boolean;
  plugins?: AgentPluginConfig[];
}

export interface AgentRoutingPolicy {
  resolve(route: AgentRoute): AgentProfile;
}

export interface DirectModelMessage {
  role: 'user';
  content: string;
}

export interface DirectModelRunRequest {
  route: AgentRoute;
  profile?: AgentProfile;
  model?: string;
  max_tokens?: number;
  messages: DirectModelMessage[];
}

export interface DirectModelRunResult {
  text: string;
  raw?: unknown;
}

export interface DirectModelRunner {
  run(request: DirectModelRunRequest): Promise<DirectModelRunResult>;
}

export interface AgentRunContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export type AgentRunEvent =
  | { type: 'assistant'; content: AgentRunContentBlock[] }
  | { type: string; [key: string]: unknown };

export interface AgentRunRequest {
  route: AgentRoute;
  profile?: AgentProfile;
  working_directory: string;
  prompt: string;
}

export interface AgentRunner {
  run(request: AgentRunRequest): AsyncIterable<AgentRunEvent>;
}

export interface ArtifactComment {
  id: string;
  body: string;
}

export interface ArtifactCommentResponse {
  comment_id: string;
  response: string;
}

export interface ArtifactCreateResult {
  artifact_path: string;
  existing_issue?: number;
}

export interface ArtifactRevisionResult {
  comment_responses: ArtifactCommentResponse[];
  page_content?: string;
}

export interface ArtifactAuthoringAgent {
  create(
    request: Request,
    workspace_path: string,
    onProgress?: (message: string) => Promise<void>,
    intent?: 'idea' | 'bug' | 'chore',
  ): Promise<ArtifactCreateResult>;
  revise(
    feedback: ThreadMessage,
    artifact_comments: ArtifactComment[],
    artifact_path: string,
    workspace_path: string,
    current_page_markdown?: string,
    onProgress?: (message: string) => Promise<void>,
  ): Promise<ArtifactRevisionResult>;
}

export type ImplementationStatus = 'complete' | 'needs_input' | 'failed';

export interface ImplementationResult {
  status: ImplementationStatus;
  summary?: string;
  testing_instructions?: string;
  question?: string;
  error?: string;
}

export interface ImplementationAgent {
  implement(
    artifact_path: string,
    working_directory: string,
    additional_context?: string,
    onProgress?: (message: string) => Promise<void>,
  ): Promise<ImplementationResult>;
}

export interface QuestionAnsweringAgent {
  answer(question: string): Promise<string>;
}

export interface IssueTriageAgent {
  triage(
    request: Request,
    working_directory: string,
    onProgress?: (message: string) => Promise<void>,
  ): Promise<IssueTriageResult>;
}

export interface IssueTriageDuplicate {
  number: number;
  title: string;
}

export interface IssueTriageItem {
  proposed_title: string;
  proposed_body: string;
  proposed_labels: string[];
  duplicate_of: IssueTriageDuplicate | null;
}

export interface IssueTriageResult {
  status: 'complete' | 'failed';
  items: IssueTriageItem[];
  error?: string;
}

export type { ClassificationContext, Intent, IntentClassifier };
