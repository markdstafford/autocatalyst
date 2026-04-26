import { rm } from 'node:fs/promises';
import type pino from 'pino';
import type { IssueFiler } from '../types/issue-filing.js';
import type { IssueManager, PRManager } from '../types/issue-tracker.js';
import type { ArtifactAuthoringAgent, ImplementationAgent, QuestionAnsweringAgent } from '../types/ai.js';
import type { Request, ThreadMessage } from '../types/events.js';
import type { ConversationRef } from '../types/channel.js';
import type { FeedbackSource } from '../types/feedback-source.js';
import type { ImplementationReviewPublisher } from '../types/impl-feedback-page.js';
import type { Intent } from '../types/intent.js';
import type { ArtifactContentSource, ArtifactPublisher } from '../types/publisher.js';
import type { ArtifactLifecyclePolicy, ArtifactKind } from '../types/artifact.js';
import type { RequestIntent, Run, RunStage } from '../types/runs.js';
import type { ChannelRepoMap } from '../types/config.js';
import type { WorkspaceManager } from './workspace-manager.js';
import type { SpecCommitter } from './spec-committer.js';
import { HandlerRegistryImpl, type HandlerRegistry } from './handler-registry.js';
import { ArtifactCreationHandler } from './handlers/artifact-creation-handler.js';
import { ArtifactApprovalHandler, type ArtifactApprovalResult } from './handlers/artifact-approval-handler.js';
import { ArtifactFeedbackHandler } from './handlers/artifact-feedback-handler.js';
import { ImplementationStartHandler } from './handlers/implementation-start-handler.js';
import { ImplementationFeedbackHandler } from './handlers/implementation-feedback-handler.js';
import { ImplementationApprovalHandler } from './handlers/implementation-approval-handler.js';
import { IssueFilingHandler } from './handlers/issue-filing-handler.js';
import { PrMergeHandler } from './handlers/pr-merge-handler.js';
import { QuestionHandler } from './handlers/question-handler.js';

type ArtifactCreationIntent = Extract<RequestIntent, 'idea' | 'bug' | 'chore'>;

export interface DefaultHandlerRegistryDeps {
  workspaceManager: Pick<WorkspaceManager, 'create' | 'destroy'>;
  artifactAuthoringAgent: Pick<ArtifactAuthoringAgent, 'create' | 'revise'>;
  artifactPublisher: ArtifactPublisher;
  artifactContentSource?: ArtifactContentSource;
  artifactPolicies?: Record<ArtifactKind, ArtifactLifecyclePolicy>;
  feedbackSource?: FeedbackSource;
  questionAnswerer?: QuestionAnsweringAgent;
  specCommitter?: Pick<SpecCommitter, 'commit' | 'updateStatus'>;
  implementer?: ImplementationAgent;
  implFeedbackPage?: ImplementationReviewPublisher;
  prManager?: PRManager;
  issueManager?: IssueManager;
  issueFiler?: IssueFiler;
  channelRepoMap: ChannelRepoMap;
  reacjiComplete?: string | null;
  postMessage: (conversation: ConversationRef, text: string) => Promise<void>;
  postError: (conversation: ConversationRef, text: string) => Promise<void>;
  transition: (run: Run, stage: RunStage) => void;
  failRun: (run: Run, conversation: ConversationRef, error: unknown) => Promise<void>;
  persist: () => void;
  reactToRunMessage: (run: Run, reaction: string) => Promise<void>;
  logger: Pick<pino.Logger, 'debug' | 'info' | 'warn' | 'error'>;
}

export function buildDefaultHandlerRegistry(deps: DefaultHandlerRegistryDeps): HandlerRegistry {
  const registry = new HandlerRegistryImpl();
  const registerNewRequest = (
    intent: RequestIntent,
    handler: (request: Request, run: Run) => Promise<void>,
  ): void => {
    registry.register({ event_type: 'new_request', stage: 'new_thread', intent }, async (event, run) => {
      if (event.type !== 'new_request' || !run) return;
      await handler(event.payload, run);
    });
  };
  const registerThreadMessage = (
    stage: RunStage,
    intent: Intent,
    handler: (feedback: ThreadMessage, run: Run) => Promise<void>,
  ): void => {
    registry.register({ event_type: 'thread_message', stage, intent }, async (event, run) => {
      if (event.type !== 'thread_message' || !run) return;
      await handler(event.payload, run);
    });
  };

  registerNewRequest('idea', (request, run) => startArtifactCreation(deps, run, request, 'idea'));
  registerNewRequest('bug', (request, run) => startArtifactCreation(deps, run, request, 'bug'));
  registerNewRequest('chore', (request, run) => startArtifactCreation(deps, run, request, 'chore'));
  registerNewRequest('file_issues', (request, run) => startFilingPipeline(deps, run, request));
  registerNewRequest('question', async (request, run) => {
    const result = await handleQuestion(deps, request.content, request.conversation, run);
    deps.transition(run, result.status === 'unavailable' ? 'failed' : 'done');
  });

  registerThreadMessage('reviewing_spec', 'feedback', (feedback, run) => handleArtifactFeedback(deps, feedback, run));
  registerThreadMessage('reviewing_implementation', 'feedback', (feedback, run) => handleImplementationFeedback(deps, feedback, run, 'reviewing_implementation'));
  registerThreadMessage('awaiting_impl_input', 'feedback', (feedback, run) => handleImplementationFeedback(deps, feedback, run, 'awaiting_impl_input'));
  registerThreadMessage('pr_open', 'feedback', (feedback, run) => handlePrOpenFeedback(deps, feedback, run));
  registerThreadMessage('reviewing_spec', 'approval', async (feedback, run) => {
    const result = await approveArtifact(deps, run, feedback);
    if (result.status === 'failed') return;
    if (!result.implementation_required) return;
    await runImplementation(deps, feedback, run);
  });
  registerThreadMessage('reviewing_implementation', 'approval', (feedback, run) => handleImplementationApproval(deps, feedback, run));
  registerThreadMessage('pr_open', 'approval', (feedback, run) => handlePrMerge(deps, feedback, run));
  registerThreadMessage('reviewing_spec', 'question', (feedback, run) => answerQuestionAndRestoreStage(deps, feedback, run, 'reviewing_spec'));
  registerThreadMessage('reviewing_implementation', 'question', (feedback, run) => answerQuestionAndRestoreStage(deps, feedback, run, 'reviewing_implementation'));
  registerThreadMessage('awaiting_impl_input', 'question', (feedback, run) => answerQuestionAndRestoreStage(deps, feedback, run, 'awaiting_impl_input'));
  registerThreadMessage('pr_open', 'question', (feedback, run) => answerQuestionAndRestoreStage(deps, feedback, run, 'pr_open'));

  return registry;
}

async function startArtifactCreation(
  deps: DefaultHandlerRegistryDeps,
  run: Run,
  request: Request,
  intent: ArtifactCreationIntent,
): Promise<void> {
  const handler = new ArtifactCreationHandler({
    workspaceManager: deps.workspaceManager,
    artifactAuthoringAgent: deps.artifactAuthoringAgent,
    artifactPublisher: deps.artifactPublisher,
    channelRepoMap: deps.channelRepoMap,
    postMessage: deps.postMessage,
    transition: deps.transition,
    failRun: deps.failRun,
    persist: deps.persist,
    logger: deps.logger,
  });
  await handler.handle(run, request, intent);
}

async function approveArtifact(
  deps: DefaultHandlerRegistryDeps,
  run: Run,
  feedback: ThreadMessage,
): Promise<ArtifactApprovalResult> {
  const handler = new ArtifactApprovalHandler({
    artifactPublisher: deps.artifactPublisher,
    artifactContentSource: artifactContentSource(deps),
    artifactPolicies: deps.artifactPolicies,
    specCommitter: deps.specCommitter,
    issueManager: deps.issueManager,
    channelRepoMap: deps.channelRepoMap,
    postMessage: deps.postMessage,
    transition: deps.transition,
    failRun: deps.failRun,
    persist: deps.persist,
    logger: deps.logger,
    deleteFile: (path) => rm(path, { force: true }),
  });
  return handler.handle(run, feedback);
}

async function handleArtifactFeedback(
  deps: DefaultHandlerRegistryDeps,
  feedback: ThreadMessage,
  run: Run,
): Promise<void> {
  const handler = new ArtifactFeedbackHandler({
    artifactAuthoringAgent: deps.artifactAuthoringAgent,
    artifactPublisher: deps.artifactPublisher,
    artifactContentSource: artifactContentSource(deps),
    feedbackSource: deps.feedbackSource,
    postMessage: deps.postMessage,
    transition: deps.transition,
    failRun: deps.failRun,
    logger: deps.logger,
  });
  await handler.handle(run, feedback);
}

async function runImplementation(
  deps: DefaultHandlerRegistryDeps,
  feedback: ThreadMessage,
  run: Run,
  additionalContext?: string,
): Promise<void> {
  const handler = new ImplementationStartHandler({
    implementer: deps.implementer!,
    implFeedbackPage: deps.implFeedbackPage,
    postMessage: deps.postMessage,
    transition: deps.transition,
    failRun: deps.failRun,
    persist: deps.persist,
    logger: deps.logger,
  });
  await handler.handle(run, feedback, additionalContext);
}

async function handleImplementationFeedback(
  deps: DefaultHandlerRegistryDeps,
  feedback: ThreadMessage,
  run: Run,
  routingStage: RunStage,
): Promise<void> {
  const handler = new ImplementationFeedbackHandler({
    implementer: deps.implementer!,
    implFeedbackPage: deps.implFeedbackPage,
    postMessage: deps.postMessage,
    transition: deps.transition,
    failRun: deps.failRun,
    persist: deps.persist,
    logger: deps.logger,
  });
  await handler.handle(run, feedback, routingStage);
}

async function handleImplementationApproval(
  deps: DefaultHandlerRegistryDeps,
  feedback: ThreadMessage,
  run: Run,
): Promise<void> {
  const handler = new ImplementationApprovalHandler({
    specCommitter: deps.specCommitter,
    artifactPublisher: deps.artifactPublisher,
    prManager: deps.prManager!,
    implFeedbackPage: deps.implFeedbackPage,
    postMessage: deps.postMessage,
    transition: deps.transition,
    failRun: deps.failRun,
    persist: deps.persist,
    logger: deps.logger,
  });
  await handler.handle(run, feedback);
}

async function handlePrMerge(deps: DefaultHandlerRegistryDeps, feedback: ThreadMessage, run: Run): Promise<void> {
  const handler = new PrMergeHandler({
    prManager: deps.prManager!,
    postMessage: deps.postMessage,
    transition: deps.transition,
    failRun: deps.failRun,
    reactToRunMessage: deps.reactToRunMessage,
    reacjiComplete: deps.reacjiComplete,
    logger: deps.logger,
  });
  await handler.handle(run, feedback);
}

async function startFilingPipeline(deps: DefaultHandlerRegistryDeps, run: Run, request: Request): Promise<void> {
  const handler = new IssueFilingHandler({
    workspaceManager: deps.workspaceManager,
    issueFiler: deps.issueFiler!,
    channelRepoMap: deps.channelRepoMap,
    postMessage: deps.postMessage,
    transition: deps.transition,
    failRun: deps.failRun,
    reactToRunMessage: deps.reactToRunMessage,
    reacjiComplete: deps.reacjiComplete,
    logger: deps.logger,
  });
  await handler.handle(run, request);
}

async function handleQuestion(
  deps: DefaultHandlerRegistryDeps,
  content: string,
  conversation: ConversationRef,
  run: Run,
): Promise<Awaited<ReturnType<QuestionHandler['handle']>>> {
  const handler = new QuestionHandler({
    questionAnswerer: deps.questionAnswerer,
    postMessage: deps.postMessage,
    postError: deps.postError,
    logger: deps.logger,
  });
  return handler.handle(content, conversation, run);
}

async function answerQuestionAndRestoreStage(
  deps: DefaultHandlerRegistryDeps,
  feedback: ThreadMessage,
  run: Run,
  stage: RunStage,
): Promise<void> {
  await handleQuestion(deps, feedback.content, feedback.conversation, run);
  deps.transition(run, stage);
}

async function handlePrOpenFeedback(
  deps: DefaultHandlerRegistryDeps,
  feedback: ThreadMessage,
  run: Run,
): Promise<void> {
  try {
    await deps.postMessage(
      feedback.conversation,
      'A PR is already open \u2014 merge it or close it first.',
    );
  } catch (err) {
    deps.logger.error({ event: 'run.notify_failed', run_id: run.id, error: String(err) }, 'Failed to post pr_open feedback message');
  }
}

function artifactContentSource(deps: DefaultHandlerRegistryDeps): ArtifactContentSource | undefined {
  if (deps.artifactContentSource) return deps.artifactContentSource;
  const publisher = deps.artifactPublisher as ArtifactPublisher & Partial<ArtifactContentSource>;
  if (typeof publisher.getContent === 'function') {
    return { getContent: publisher.getContent.bind(publisher) };
  }
  return undefined;
}
