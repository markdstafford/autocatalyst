import type { Message, Project, Run } from '@autocatalyst/api-contract';
import {
  SpecAuthorContextError,
  assertSupportedSpecAuthorWorkKind,
  toSafeDetails,
  type DomainRepositories,
  type SpecAuthorLinkedIssueContext,
  type SpecAuthorPromptInput,
  type SpecAuthorSupportedWorkKind
} from '@autocatalyst/core';

export type SpecAuthoringContextLoadErrorCode =
  | 'tenant_required'
  | 'run_not_found'
  | 'topic_not_found'
  | 'conversation_not_found'
  | 'project_not_found'
  | 'tenant_mismatch'
  | 'unsupported_step'
  | 'unsupported_work_kind'
  | 'missing_request_context'
  | 'issue_read_failed';

export class SpecAuthoringContextLoadError extends Error {
  readonly code: SpecAuthoringContextLoadErrorCode;
  readonly safeDetails?: Readonly<Record<string, unknown>>;

  constructor(code: SpecAuthoringContextLoadErrorCode, message: string, safeDetails?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = 'SpecAuthoringContextLoadError';
    this.code = code;
    if (safeDetails !== undefined) this.safeDetails = safeDetails;
  }
}

export interface IssueContextReader {
  read(input: {
    readonly tenantId: string;
    readonly run: Run;
    readonly project: Project;
    readonly issueNumber: number;
  }): Promise<Omit<SpecAuthorLinkedIssueContext, 'number'> & { readonly number?: number }>;
}

export interface LoadSpecAuthorPromptInputRequest {
  readonly runId: string;
  readonly tenantId?: string;
  readonly repositories: DomainRepositories;
  readonly repositoriesEnforceTenantIsolation?: boolean;
  readonly issues?: IssueContextReader;
}

function assertTenant(entity: { readonly tenant: string }, tenantId: string, entityName: string, runId: string): void {
  if (entity.tenant !== tenantId) {
    throw new SpecAuthoringContextLoadError('tenant_mismatch', 'Loaded spec authoring context crossed tenant boundary.', toSafeDetails({ entityName, runId }));
  }
}

function sortMessages(messages: readonly Message[]): readonly Message[] {
  return [...messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function requestTextFrom(input: { readonly messages: readonly Message[]; readonly issue?: SpecAuthorLinkedIssueContext; readonly topicTitle: string }): string {
  const inbound = input.messages.filter((m) => m.direction === 'inbound').map((m) => m.body.trim()).filter(Boolean);
  const parts = [input.topicTitle.trim(), input.issue?.title, input.issue?.body, ...inbound].filter((v): v is string => v !== undefined && v.trim().length > 0);
  return parts.join('\n\n');
}

export async function loadSpecAuthorPromptInput(request: LoadSpecAuthorPromptInputRequest): Promise<SpecAuthorPromptInput> {
  if (request.tenantId === undefined && request.repositoriesEnforceTenantIsolation !== true) {
    throw new SpecAuthoringContextLoadError('tenant_required', 'tenantId is required when repositories do not enforce tenant isolation.', toSafeDetails({ runId: request.runId }));
  }
  const run = await request.repositories.runs.findById(request.runId);
  if (run === null) {
    throw new SpecAuthoringContextLoadError('run_not_found', 'Run not found for spec authoring context.', toSafeDetails({ runId: request.runId }));
  }
  if (request.tenantId !== undefined) assertTenant(run, request.tenantId, 'run', request.runId);
  if (run.currentStep !== 'spec.author') {
    throw new SpecAuthoringContextLoadError('unsupported_step', 'Run is not at spec.author.', toSafeDetails({ runId: request.runId, currentStep: run.currentStep }));
  }
  try {
    assertSupportedSpecAuthorWorkKind(run.workKind);
  } catch (error) {
    if (error instanceof SpecAuthorContextError) {
      throw new SpecAuthoringContextLoadError('unsupported_work_kind', 'Run work kind is not supported for spec.author.', toSafeDetails({ runId: request.runId, workKind: run.workKind }));
    }
    throw error;
  }

  const topic = await request.repositories.topics.findById(run.topicId);
  if (topic === null) throw new SpecAuthoringContextLoadError('topic_not_found', 'Topic not found for spec authoring context.', toSafeDetails({ runId: request.runId }));
  if (request.tenantId !== undefined) assertTenant(topic, request.tenantId, 'topic', request.runId);

  const conversation = await request.repositories.conversations.findById(topic.conversationId);
  if (conversation === null) throw new SpecAuthoringContextLoadError('conversation_not_found', 'Conversation not found for spec authoring context.', toSafeDetails({ runId: request.runId }));
  if (request.tenantId !== undefined) assertTenant(conversation, request.tenantId, 'conversation', request.runId);

  const project = await request.repositories.projects.findById(conversation.projectId);
  if (project === null) throw new SpecAuthoringContextLoadError('project_not_found', 'Project not found for spec authoring context.', toSafeDetails({ runId: request.runId }));
  if (request.tenantId !== undefined) assertTenant(project, request.tenantId, 'project', request.runId);

  const messages = sortMessages(await request.repositories.messages.listByTopic(topic.id));
  for (const message of messages) {
    if (request.tenantId !== undefined) assertTenant(message, request.tenantId, 'message', request.runId);
  }

  let linkedIssue: SpecAuthorLinkedIssueContext | undefined = run.trackedIssue?.number !== undefined ? { number: run.trackedIssue.number } : undefined;
  if (request.tenantId !== undefined && request.issues !== undefined && run.trackedIssue?.number !== undefined) {
    try {
      const issue = await request.issues.read({ tenantId: request.tenantId, run, project, issueNumber: run.trackedIssue.number });
      linkedIssue = {
        number: issue.number ?? run.trackedIssue.number,
        ...(issue.title !== undefined ? { title: issue.title } : {}),
        ...(issue.body !== undefined ? { body: issue.body } : {}),
        ...(issue.labels !== undefined ? { labels: issue.labels } : {})
      };
    } catch {
      throw new SpecAuthoringContextLoadError('issue_read_failed', 'Issue metadata could not be loaded for spec authoring context.', toSafeDetails({ runId: request.runId, issueNumber: run.trackedIssue.number }));
    }
  }

  const text = requestTextFrom({ messages, ...(linkedIssue !== undefined ? { issue: linkedIssue } : {}), topicTitle: topic.title });
  if (text.trim().length === 0) {
    throw new SpecAuthoringContextLoadError('missing_request_context', 'Spec authoring context has no actionable request text.', toSafeDetails({ runId: request.runId }));
  }

  return {
    run,
    project,
    conversation,
    topic,
    messages,
    request: { text, classification: run.workKind as SpecAuthorSupportedWorkKind },
    ...(linkedIssue !== undefined ? { linkedIssue } : {})
  };
}
