import type {
  CreateConversationWithFirstRunRequest,
  CreateConversationWithFirstRunResponse,
  CreateRunFeedbackRequest,
  Feedback,
  NonModelPrincipal,
  Principal,
  Run,
  RunPullRequestResponse,
  RunRecoveryRequest,
  RunRecoveryResponse,
  RunReplyRequest,
  RunReplyResponse,
  RunSessionListResponse,
  RunSpecResponse,
  RunStep,
  Session
} from '@autocatalyst/api-contract';
import { createConversationWithFirstRunResponseSchema, pullRequestReconciliationResponseSchema, runFeedbackListResponseSchema, runPullRequestResponseSchema, runRecoveryResponseSchema, runReplyResponseSchema, runSessionListResponseSchema, runSpecResponseSchema } from '@autocatalyst/api-contract';
import type { ReconcilePullRequestsResponse } from '@autocatalyst/api-contract';

import {
  createRunRecoveryEvent
} from './run-events.js';
import {
  findStoppedStep,
  resolveRecoveryPlan,
  RecoveryPlanError,
  RunRecoveryWorkspaceError,
  type RunRecoveryDependencies
} from './run-recovery.js';

import type { ArtifactRepository, FeedbackRepository, ProjectRepository, PullRequestRepository, RunRepository, RunStepRepository, RunWorkspaceMetadataRepository, SessionRepository } from './domain-repositories.js';
import type { FeedbackLifecycleDependencies } from './feedback-lifecycle.js';
import { appendFeedbackThreadReply, createArtifactFeedback, FeedbackLifecycleError } from './feedback-lifecycle.js';
import type { IssueReferenceIntakeResolver, ResolvedConversationCreate } from './issue-reference-intake.js';
import { IssueReferenceIntakeError } from './issue-reference-intake.js';
import {
  OrchestratorError,
  type OrchestratedConversationResult,
  type Orchestrator,
  type OrchestratorErrorCode
} from './orchestrator.js';
import type { PolicyDecisionPoint, PolicyResourceDescriptor } from './policy.js';
import type { RunEventStore, RunEventSubscription } from './run-events.js';
import type { RunEventReplayResult } from '@autocatalyst/api-contract';
import { parseSpecFrontmatter } from './spec-frontmatter.js';
import type { WorkspaceFileSystemPort } from './spec-authoring-service.js';
import { getRunStepDefinition } from './run-step-catalog.js';
import { buildEntryRunStep } from './run-lifecycle.js';

// --- Error types ---

export type ControlPlaneServiceErrorCode =
  | 'not_found'
  | 'forbidden'
  | 'intake_routing_error'
  | 'active_run_conflict'
  | 'persistence_failed'
  | 'unauthorized'
  | 'conflict'
  | 'invalid_transition'
  | 'unsupported_pause';

export interface ControlPlaneServiceConflictDetails {
  readonly topicId: string;
  readonly existingRunId: string | null;
}

export interface ControlPlaneServiceErrorOptions {
  readonly details?: unknown;
  readonly cause?: unknown;
}

export class ControlPlaneServiceError extends Error {
  readonly code: ControlPlaneServiceErrorCode;
  readonly details?: unknown;
  override readonly cause?: unknown;

  constructor(
    code: ControlPlaneServiceErrorCode,
    message: string,
    options: ControlPlaneServiceErrorOptions = {}
  ) {
    super(message);
    this.name = 'ControlPlaneServiceError';
    this.code = code;
    if (options.details !== undefined) this.details = options.details;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

// --- Input/result types ---

export interface ServiceCreateConversationInput {
  readonly principal: Principal;
  readonly tenant: string;
  readonly request: CreateConversationWithFirstRunRequest;
}

export interface ServiceListRunsInput {
  readonly principal: Principal;
  readonly tenant: string;
}

export interface ServiceListRunsResult {
  readonly runs: readonly Run[];
}

export interface ServiceGetRunInput {
  readonly principal: Principal;
  readonly tenant: string;
  readonly runId: string;
}

export interface ServiceGetRunResult {
  readonly run: Run;
}

export interface ServiceListRunStepsInput {
  readonly principal: Principal;
  readonly tenant: string;
  readonly runId: string;
}

export interface ServiceListRunStepsResult {
  readonly steps: readonly RunStep[];
}

export interface ServiceSubscribeRunEventsInput {
  readonly principal: Principal;
  readonly tenant: string;
  readonly runId: string;
  readonly lastEventId?: string;
}

export interface ServiceReplayRunEventsInput {
  readonly principal: Principal;
  readonly tenant: string;
  readonly runId: string;
  readonly lastEventId?: string;
  readonly replay?: 'retained';
}

export interface ServiceTickInput {
  readonly principal: Principal;
  readonly tenant: string;
  readonly runId?: string;
}

export type ServiceTickResult =
  | { readonly status: 'noop' }
  | { readonly status: 'dispatched'; readonly runId: string };

export interface ServiceGetRunSpecInput {
  readonly principal: Principal;
  readonly tenant: string;
  readonly runId: string;
}

export type ServiceGetRunSpecResult = RunSpecResponse;

export interface ServiceCreateRunFeedbackInput {
  readonly principal: Principal;
  readonly tenant: string;
  readonly runId: string;
  readonly request: CreateRunFeedbackRequest;
}

export type ServiceCreateRunFeedbackResult = Feedback;

export interface ServiceListRunFeedbackInput {
  readonly principal: Principal;
  readonly tenant: string;
  readonly runId: string;
}

export interface ServiceListRunFeedbackResult {
  readonly feedback: readonly Feedback[];
}

export interface AppendRunFeedbackThreadReplyInput {
  readonly principal: Principal;
  readonly tenant: string;
  readonly runId: string;
  readonly feedbackId: string;
  readonly body: string;
}

export interface ServiceReplyToRunInput {
  readonly principal: Principal;
  readonly tenant: string;
  readonly runId: string;
  readonly request: RunReplyRequest;
}

export interface ServiceRecoverRunInput {
  readonly principal: Principal;
  readonly tenant: string;
  readonly runId: string;
  readonly request: RunRecoveryRequest;
}

export type ServiceRecoverRunResult = RunRecoveryResponse;

export interface ServiceReconcilePullRequestsInput {
  readonly principal: NonModelPrincipal;
  readonly tenant: string;
}

export type ServiceReconcilePullRequestsResult = ReconcilePullRequestsResponse;

export interface ServiceGetRunPullRequestInput {
  readonly principal: Principal;
  readonly tenant: string;
  readonly runId: string;
}

export type ServiceGetRunPullRequestResult = RunPullRequestResponse;

export interface ServiceListRunSessionsInput {
  readonly principal: Principal;
  readonly tenant: string;
  readonly runId: string;
}

export type ServiceListRunSessionsResult = RunSessionListResponse;

// --- Service interface ---

export interface ControlPlaneService {
  createConversationWithFirstRun(
    input: ServiceCreateConversationInput
  ): Promise<CreateConversationWithFirstRunResponse>;
  listRuns(input: ServiceListRunsInput): Promise<ServiceListRunsResult>;
  getRun(input: ServiceGetRunInput): Promise<ServiceGetRunResult>;
  listRunSteps(input: ServiceListRunStepsInput): Promise<ServiceListRunStepsResult>;
  subscribeRunEvents(input: ServiceSubscribeRunEventsInput): Promise<RunEventSubscription>;
  replayRunEvents(input: ServiceReplayRunEventsInput): Promise<RunEventReplayResult>;
  tick(input: ServiceTickInput): Promise<ServiceTickResult>;
  getRunSpec(input: ServiceGetRunSpecInput): Promise<ServiceGetRunSpecResult>;
  createRunFeedback(input: ServiceCreateRunFeedbackInput): Promise<ServiceCreateRunFeedbackResult>;
  listRunFeedback(input: ServiceListRunFeedbackInput): Promise<ServiceListRunFeedbackResult>;
  appendRunFeedbackThreadReply(input: AppendRunFeedbackThreadReplyInput): Promise<Feedback>;
  replyToRun(input: ServiceReplyToRunInput): Promise<RunReplyResponse>;
  recoverRun(input: ServiceRecoverRunInput): Promise<ServiceRecoverRunResult>;
  reconcilePullRequests(input: ServiceReconcilePullRequestsInput): Promise<ServiceReconcilePullRequestsResult>;
  getRunPullRequest(input: ServiceGetRunPullRequestInput): Promise<ServiceGetRunPullRequestResult>;
  listRunSessions(input: ServiceListRunSessionsInput): Promise<ServiceListRunSessionsResult>;
}

// --- Constructor options ---

export interface DefaultControlPlaneServiceOptions {
  readonly orchestrator: Orchestrator;
  readonly runs: RunRepository;
  readonly runSteps: RunStepRepository;
  readonly events: RunEventStore;
  readonly policy: PolicyDecisionPoint;
  readonly artifacts: ArtifactRepository;
  readonly feedback: FeedbackRepository;
  readonly runWorkspaceMetadata: RunWorkspaceMetadataRepository;
  readonly workspaceFilesystem: WorkspaceFileSystemPort;
  readonly feedbackLifecycle: FeedbackLifecycleDependencies;
  readonly projects: ProjectRepository;
  readonly issueReferenceIntakeResolver: IssueReferenceIntakeResolver;
  readonly pullRequests: PullRequestRepository;
  readonly sessions: SessionRepository;
  /**
   * Host-provided recovery workspace seam. Required for `recoverRun`; when absent, recovery
   * requests fail with a persistence error rather than silently skipping materialization.
   */
  readonly recovery?: RunRecoveryDependencies;
}

// --- Implementation ---

function isActiveRunConflictError(error: unknown): boolean {
  return error instanceof Error && error.name === 'ActiveRunConflictPersistenceError';
}

function mapOrchestratorErrorCode(code: OrchestratorErrorCode): ControlPlaneServiceErrorCode {
  switch (code) {
    case 'forbidden':
      return 'forbidden';
    case 'missing_run':
      return 'not_found';
    case 'active_run_conflict':
      return 'active_run_conflict';
    default:
      return 'persistence_failed';
  }
}

function specArtifactKindForRun(workKind: string): 'feature_spec' | 'enhancement_spec' | null {
  if (workKind === 'feature') return 'feature_spec';
  if (workKind === 'enhancement') return 'enhancement_spec';
  return null;
}

function persistenceFailed(message: string, cause?: unknown): ControlPlaneServiceError {
  return new ControlPlaneServiceError('persistence_failed', message, cause === undefined ? {} : { cause });
}

async function requireTenantRun(input: {
  readonly runs: RunRepository;
  readonly runId: string;
  readonly tenant: string;
}): Promise<Run> {
  let run: Run | null;
  try {
    run = await input.runs.findById(input.runId);
  } catch (error) {
    throw persistenceFailed('Failed to load run.', error);
  }
  if (run === null || run.tenant !== input.tenant) {
    throw new ControlPlaneServiceError('not_found', `Run '${input.runId}' not found.`);
  }
  return run;
}

function requireNonModelPrincipal(principal: Principal): NonModelPrincipal {
  if (principal.kind === 'model') {
    throw new ControlPlaneServiceError('unauthorized', 'Model principals cannot create feedback.');
  }
  return principal as NonModelPrincipal;
}

function mapRunToApiRun(run: Run): Run {
  const definition = getRunStepDefinition(run.currentStep);
  if (definition === null) {
    throw persistenceFailed(`Unknown run step '${run.currentStep}'.`);
  }
  return { ...run, waitingOn: definition.waitingOn };
}

export class DefaultControlPlaneService implements ControlPlaneService {
  readonly #orchestrator: Orchestrator;
  readonly #runs: RunRepository;
  readonly #runSteps: RunStepRepository;
  readonly #events: RunEventStore;
  readonly #policy: PolicyDecisionPoint;
  readonly #artifacts: ArtifactRepository;
  readonly #feedback: FeedbackRepository;
  readonly #runWorkspaceMetadata: RunWorkspaceMetadataRepository;
  readonly #workspaceFilesystem: WorkspaceFileSystemPort;
  readonly #feedbackLifecycle: FeedbackLifecycleDependencies;
  readonly #projects: ProjectRepository;
  readonly #issueReferenceIntakeResolver: IssueReferenceIntakeResolver;
  readonly #pullRequests: PullRequestRepository;
  readonly #sessions: SessionRepository;
  readonly #recovery: RunRecoveryDependencies | undefined;

  constructor(options: DefaultControlPlaneServiceOptions) {
    this.#orchestrator = options.orchestrator;
    this.#runs = options.runs;
    this.#runSteps = options.runSteps;
    this.#events = options.events;
    this.#policy = options.policy;
    this.#artifacts = options.artifacts;
    this.#feedback = options.feedback;
    this.#runWorkspaceMetadata = options.runWorkspaceMetadata;
    this.#workspaceFilesystem = options.workspaceFilesystem;
    this.#feedbackLifecycle = options.feedbackLifecycle;
    this.#projects = options.projects;
    this.#issueReferenceIntakeResolver = options.issueReferenceIntakeResolver;
    this.#pullRequests = options.pullRequests;
    this.#sessions = options.sessions;
    this.#recovery = options.recovery;
  }

  async createConversationWithFirstRun(
    input: ServiceCreateConversationInput
  ): Promise<CreateConversationWithFirstRunResponse> {
    const decision = await this.#policy.authorize({
      principal: input.principal,
      action: 'conversation.create',
      resource: { kind: 'conversation_collection', path: '/v1/conversations' }
    });
    if (!decision.allowed) {
      throw new ControlPlaneServiceError('forbidden', 'Not authorized to create conversations.');
    }

    const { request } = input;
    // Cast: the development principal is always non-model. Routes are responsible
    // for ensuring this invariant before invoking the service.
    const ownerPrincipal = input.principal as NonModelPrincipal;

    // Load project for intake resolution
    const project = await this.#projects.findById(request.projectId);
    if (project === null || project.tenant !== input.tenant) {
      throw new ControlPlaneServiceError(
        'intake_routing_error',
        `Project '${request.projectId}' is not accessible.`
      );
    }

    // Resolve intake (issue reference lookup, work-kind settlement)
    let resolved: ResolvedConversationCreate;
    try {
      resolved = await this.#issueReferenceIntakeResolver.resolve({
        submission: request.submission,
        project,
        tenant: input.tenant
      });
    } catch (error: unknown) {
      if (error instanceof IssueReferenceIntakeError) {
        throw new ControlPlaneServiceError('intake_routing_error', error.message, {
          ...(error.safeDetails !== undefined ? { details: error.safeDetails } : {}),
          cause: error
        });
      }
      throw error;
    }

    let result: OrchestratedConversationResult;
    try {
      result = await this.#orchestrator.createConversationWithFirstRun({
        projectId: request.projectId,
        owner: ownerPrincipal,
        tenant: input.tenant,
        identity: request.identity,
        ...(request.channel !== undefined ? { channel: request.channel } : {}),
        topic: { title: request.topic.title },
        message: { body: resolved.messageBody },
        workKind: resolved.workKind,
        ...(resolved.trackedIssue !== undefined
          ? { trackedIssue: resolved.trackedIssue }
          : {})
      });
    } catch (error) {
      if (error instanceof OrchestratorError) {
        if (error.code === 'unknown_work_kind' || error.code === 'invalid_transition') {
          throw new ControlPlaneServiceError('intake_routing_error', error.message, { cause: error });
        }
        if (error.code === 'active_run_conflict') {
          throw new ControlPlaneServiceError('active_run_conflict', error.message, {
            details: error.details,
            cause: error
          });
        }
        throw new ControlPlaneServiceError('persistence_failed', error.message, { cause: error });
      }
      throw error;
    }

    const response: CreateConversationWithFirstRunResponse = {
      conversation: result.conversation,
      topic: result.topic,
      ...(result.message !== undefined ? { message: result.message } : {}),
      run: result.run,
      runStep: result.runStep
    };
    return createConversationWithFirstRunResponseSchema.parse(response);
  }

  async listRuns(input: ServiceListRunsInput): Promise<ServiceListRunsResult> {
    const decision = await this.#policy.authorize({
      principal: input.principal,
      action: 'run.list',
      resource: { kind: 'run_collection', path: '/v1/runs' }
    });
    if (!decision.allowed) {
      throw new ControlPlaneServiceError('forbidden', 'Not authorized to list runs.');
    }

    const runs = await this.#runs.listByTenant(input.tenant);
    return { runs: runs.map(mapRunToApiRun) };
  }

  async getRun(input: ServiceGetRunInput): Promise<ServiceGetRunResult> {
    const decision = await this.#policy.authorize({
      principal: input.principal,
      action: 'run.read',
      resource: { kind: 'run', id: input.runId, path: '/v1/runs/:id' }
    });
    if (!decision.allowed) {
      throw new ControlPlaneServiceError('forbidden', 'Not authorized to read runs.');
    }

    const run = await this.#runs.findById(input.runId);
    if (run === null) {
      throw new ControlPlaneServiceError('not_found', `Run '${input.runId}' not found.`);
    }
    if (run.tenant !== input.tenant) {
      throw new ControlPlaneServiceError('forbidden', 'Run not accessible.');
    }

    return { run: mapRunToApiRun(run) };
  }

  async listRunSteps(input: ServiceListRunStepsInput): Promise<ServiceListRunStepsResult> {
    const decision = await this.#policy.authorize({
      principal: input.principal,
      action: 'run_steps.list',
      resource: { kind: 'run_steps', id: input.runId, path: '/v1/runs/:id/steps' }
    });
    if (!decision.allowed) {
      throw new ControlPlaneServiceError('forbidden', 'Not authorized to list run steps.');
    }

    const run = await this.#runs.findById(input.runId);
    if (run === null) {
      throw new ControlPlaneServiceError('not_found', `Run '${input.runId}' not found.`);
    }
    if (run.tenant !== input.tenant) {
      throw new ControlPlaneServiceError('forbidden', 'Run not accessible.');
    }

    const steps = await this.#runSteps.listByRun(input.runId);
    return { steps };
  }

  async subscribeRunEvents(input: ServiceSubscribeRunEventsInput): Promise<RunEventSubscription> {
    const decision = await this.#policy.authorize({
      principal: input.principal,
      action: 'run_events.stream',
      resource: { kind: 'run_events', id: input.runId, path: '/v1/runs/:id/events' }
    });
    if (!decision.allowed) {
      throw new ControlPlaneServiceError('forbidden', 'Not authorized to stream run events.');
    }

    const run = await this.#runs.findById(input.runId);
    if (run === null) {
      throw new ControlPlaneServiceError('not_found', `Run '${input.runId}' not found.`);
    }
    if (run.tenant !== input.tenant) {
      throw new ControlPlaneServiceError('forbidden', 'Run not accessible.');
    }

    return this.#events.subscribe({
      runId: input.runId,
      tenant: input.tenant
    });
  }

  async replayRunEvents(input: ServiceReplayRunEventsInput): Promise<RunEventReplayResult> {
    const decision = await this.#policy.authorize({
      principal: input.principal,
      action: 'run_events.stream',
      resource: { kind: 'run_events', id: input.runId, path: '/v1/runs/:id/events' }
    });
    if (!decision.allowed) {
      throw new ControlPlaneServiceError('forbidden', 'Not authorized to stream run events.');
    }

    const run = await this.#runs.findById(input.runId);
    if (run === null) {
      throw new ControlPlaneServiceError('not_found', `Run '${input.runId}' not found.`);
    }
    if (run.tenant !== input.tenant) {
      throw new ControlPlaneServiceError('forbidden', 'Run not accessible.');
    }

    return this.#events.replayAfter({
      runId: input.runId,
      tenant: input.tenant,
      ...(input.lastEventId !== undefined ? { lastEventId: input.lastEventId } : {}),
      ...(input.replay === 'retained' ? { replay: 'retained' as const } : {})
    });
  }

  async tick(input: ServiceTickInput): Promise<ServiceTickResult> {
    const resource: PolicyResourceDescriptor =
      input.runId !== undefined
        ? { kind: 'run', id: input.runId, path: '/v1/runs/:id' }
        : { kind: 'conversation_collection', path: '/v1/conversations' };
    const decision = await this.#policy.authorize({
      principal: input.principal,
      action: 'run.tick',
      resource
    });
    if (!decision.allowed) {
      throw new ControlPlaneServiceError('forbidden', 'Not authorized to tick.');
    }

    try {
      return await this.#orchestrator.tick({
        ...(input.runId !== undefined ? { runId: input.runId } : {}),
        tenant: input.tenant
      });
    } catch (error) {
      if (error instanceof OrchestratorError) {
        throw new ControlPlaneServiceError(mapOrchestratorErrorCode(error.code), error.message, {
          ...(error.details !== undefined ? { details: error.details } : {}),
          cause: error
        });
      }
      throw error;
    }
  }

  async getRunSpec(input: ServiceGetRunSpecInput): Promise<ServiceGetRunSpecResult> {
    const decision = await this.#policy.authorize({
      principal: input.principal,
      action: 'run_spec.read',
      resource: { kind: 'run_spec', id: input.runId, path: '/v1/runs/:id/spec' }
    });
    if (!decision.allowed) {
      throw new ControlPlaneServiceError('forbidden', 'Not authorized to read run spec.');
    }

    // Load and tenant-check the run
    const run = await this.#runs.findById(input.runId);
    if (run === null) {
      throw new ControlPlaneServiceError('not_found', `Run '${input.runId}' not found.`);
    }
    if (run.tenant !== input.tenant) {
      throw new ControlPlaneServiceError('not_found', 'Run not accessible.');
    }

    // Select the spec artifact kind based on run work kind
    const artifactKind = specArtifactKindForRun(run.workKind);
    if (artifactKind === null) {
      throw new ControlPlaneServiceError('not_found', `Run work kind '${run.workKind}' does not support spec reads.`);
    }

    // Find the current spec artifact
    const artifact = await this.#artifacts.findByRunAndKind({ runId: run.id, kind: artifactKind });
    if (artifact === null) {
      throw new ControlPlaneServiceError('not_found', `No spec artifact found for run '${run.id}'.`);
    }
    if (artifact.canonicalRecord !== 'file') {
      throw new ControlPlaneServiceError('not_found', `Spec artifact for run '${run.id}' is not file-canonical.`);
    }

    // Load workspace metadata
    let workspaceMetadata;
    try {
      workspaceMetadata = await this.#runWorkspaceMetadata.findByRunId(run.id);
    } catch (error) {
      throw persistenceFailed('Failed to load workspace metadata.', error);
    }
    if (workspaceMetadata === null) {
      throw persistenceFailed('Run workspace metadata is not available.');
    }

    // Read the committed spec file
    let markdown: string;
    try {
      markdown = await this.#workspaceFilesystem.readFile({
        workspaceRepoRoot: workspaceMetadata.workspaceRepoRoot,
        relativePath: artifact.location
      });
    } catch (error) {
      throw persistenceFailed('Failed to read spec file.', error);
    }

    // Parse frontmatter
    let frontmatter;
    try {
      frontmatter = parseSpecFrontmatter(markdown);
    } catch (error) {
      throw persistenceFailed('Failed to parse spec frontmatter.', error);
    }

    return runSpecResponseSchema.parse({ artifact, markdown, frontmatter });
  }

  async createRunFeedback(input: ServiceCreateRunFeedbackInput): Promise<ServiceCreateRunFeedbackResult> {
    const decision = await this.#policy.authorize({
      principal: input.principal,
      action: 'run_feedback.create',
      resource: { kind: 'run_feedback', id: input.runId, path: '/v1/runs/:id/feedback' }
    });
    if (!decision.allowed) {
      throw new ControlPlaneServiceError('forbidden', 'Not authorized to create run feedback.');
    }

    const author = requireNonModelPrincipal(input.principal);

    const run = await this.#runs.findById(input.runId);
    if (run === null) {
      throw new ControlPlaneServiceError('not_found', `Run '${input.runId}' not found.`);
    }
    if (run.tenant !== input.tenant) {
      throw new ControlPlaneServiceError('not_found', 'Run not accessible.');
    }

    try {
      return await createArtifactFeedback({
        runId: run.id,
        owner: run.owner,
        tenant: run.tenant,
        principal: author,
        title: input.request.title,
        body: input.request.body,
        ...(input.request.anchor !== undefined ? { anchor: input.request.anchor } : {})
      }, this.#feedbackLifecycle);
    } catch (error) {
      throw persistenceFailed('Failed to create feedback.', error);
    }
  }

  async listRunFeedback(input: ServiceListRunFeedbackInput): Promise<ServiceListRunFeedbackResult> {
    const decision = await this.#policy.authorize({
      principal: input.principal,
      action: 'run_feedback.list',
      resource: { kind: 'run_feedback', id: input.runId, path: '/v1/runs/:id/feedback' }
    });
    if (!decision.allowed) {
      throw new ControlPlaneServiceError('forbidden', 'Not authorized to list run feedback.');
    }

    const run = await this.#runs.findById(input.runId);
    if (run === null) {
      throw new ControlPlaneServiceError('not_found', `Run '${input.runId}' not found.`);
    }
    if (run.tenant !== input.tenant) {
      throw new ControlPlaneServiceError('not_found', 'Run not accessible.');
    }

    let feedbackItems: readonly Feedback[];
    try {
      feedbackItems = await this.#feedback.listByRun(run.id);
    } catch (error) {
      throw persistenceFailed('Failed to list feedback.', error);
    }

    return runFeedbackListResponseSchema.parse({ feedback: feedbackItems });
  }

  async appendRunFeedbackThreadReply(input: AppendRunFeedbackThreadReplyInput): Promise<Feedback> {
    const actor = requireNonModelPrincipal(input.principal);

    const decision = await this.#policy.authorize({
      principal: input.principal,
      action: 'run_feedback.thread.append',
      resource: { kind: 'run_feedback_thread', id: input.runId, path: '/v1/runs/:id/feedback/:feedbackId/thread' }
    });
    if (!decision.allowed) {
      throw new ControlPlaneServiceError('forbidden', 'Not authorized to append feedback thread replies.');
    }

    const run = await this.#runs.findById(input.runId);
    if (run === null || run.tenant !== input.tenant) {
      throw new ControlPlaneServiceError('not_found', `Run '${input.runId}' not found.`);
    }

    const feedback = await this.#feedback.findById(input.feedbackId);
    if (feedback === null || feedback.tenant !== input.tenant || feedback.runId !== run.id) {
      throw new ControlPlaneServiceError('not_found', 'Feedback not found.');
    }

    try {
      return await appendFeedbackThreadReply({
        feedbackId: input.feedbackId,
        actor,
        body: input.body
      }, this.#feedbackLifecycle);
    } catch (error) {
      if (error instanceof FeedbackLifecycleError && error.code === 'feedback_missing') {
        throw new ControlPlaneServiceError('not_found', 'Feedback not found.');
      }
      throw persistenceFailed('Failed to append feedback thread reply.', error);
    }
  }

  async reconcilePullRequests(input: ServiceReconcilePullRequestsInput): Promise<ServiceReconcilePullRequestsResult> {
    const decision = await this.#policy.authorize({
      principal: input.principal,
      action: 'pull_request.reconcile',
      resource: { kind: 'pull_request_reconciliation', path: '/v1/pull-requests/reconcile' }
    });
    if (!decision.allowed) throw new ControlPlaneServiceError('forbidden', 'Not authorized to reconcile pull requests.');
    if (input.tenant !== input.principal.tenantId) throw new ControlPlaneServiceError('forbidden', 'Tenant not accessible.');

    try {
      return pullRequestReconciliationResponseSchema.parse(await this.#orchestrator.detectMerges(input.tenant));
    } catch (error) {
      if (error instanceof OrchestratorError) {
        throw new ControlPlaneServiceError(mapOrchestratorErrorCode(error.code), error.message, {
          ...(error.details !== undefined ? { details: error.details } : {}),
          cause: error
        });
      }
      throw error;
    }
  }

  async getRunPullRequest(input: ServiceGetRunPullRequestInput): Promise<ServiceGetRunPullRequestResult> {
    await requireTenantRun({ runs: this.#runs, runId: input.runId, tenant: input.tenant });

    let pullRequest;
    try {
      pullRequest = await this.#pullRequests.findByRun(input.runId);
    } catch (error) {
      throw persistenceFailed('Failed to load run pull request.', error);
    }
    if (pullRequest === null || pullRequest.tenant !== input.tenant) {
      throw new ControlPlaneServiceError('not_found', `Pull request for run '${input.runId}' not found.`);
    }
    return runPullRequestResponseSchema.parse({ pullRequest });
  }

  async listRunSessions(input: ServiceListRunSessionsInput): Promise<ServiceListRunSessionsResult> {
    await requireTenantRun({ runs: this.#runs, runId: input.runId, tenant: input.tenant });

    let sessions: readonly Session[];
    try {
      sessions = await this.#sessions.listByRun(input.runId);
    } catch (error) {
      throw persistenceFailed('Failed to list run sessions.', error);
    }
    return runSessionListResponseSchema.parse({ sessions });
  }

  async replyToRun(input: ServiceReplyToRunInput): Promise<RunReplyResponse> {
    const decision = await this.#policy.authorize({
      principal: input.principal,
      action: 'run_replies.create',
      resource: { kind: 'run_replies', id: input.runId, path: '/v1/runs/:id/replies' }
    });
    if (!decision.allowed) throw new ControlPlaneServiceError('forbidden', 'Not authorized to reply to runs.');

    const principal = requireNonModelPrincipal(input.principal);
    const run = await this.#runs.findById(input.runId);
    if (run === null || run.tenant !== input.tenant) throw new ControlPlaneServiceError('not_found', `Run '${input.runId}' not found.`);
    // A stopped run is never a reply target. Point a failed run at recovery and reject a
    // canceled run as unrecoverable; other terminal states keep a clear terminal conflict.
    if (run.terminal) {
      if (run.currentStep === 'failed') {
        throw new ControlPlaneServiceError('conflict', `Run '${input.runId}' is stopped; use POST /v1/runs/${input.runId}/recover to recover it.`);
      }
      if (run.currentStep === 'canceled') {
        throw new ControlPlaneServiceError('conflict', `Run '${input.runId}' was canceled and cannot be recovered.`);
      }
      throw new ControlPlaneServiceError('conflict', `Run '${input.runId}' is terminal.`);
    }
    const stepDefinition = getRunStepDefinition(run.currentStep);
    if (stepDefinition?.waitingOn !== 'human') throw new ControlPlaneServiceError('conflict', `Run '${input.runId}' is not waiting on human input.`);

    try {
      const result = await this.#orchestrator.replyToRun({
        runId: input.runId,
        tenant: input.tenant,
        principal,
        request: input.request
      });
      return runReplyResponseSchema.parse({ run: mapRunToApiRun(result.run), classification: result.classification });
    } catch (error) {
      if (error instanceof OrchestratorError) {
        if (error.details !== null && typeof error.details === 'object' && (error.details as { code?: unknown }).code === 'unsupported_pause') {
          throw new ControlPlaneServiceError('unsupported_pause', 'Unsupported human pause.', { cause: error });
        }
        if (error.code === 'invalid_transition') {
          const details = error.details as { code?: unknown } | null;
          if (details !== null && typeof details === 'object' && details.code === 'feedback_gate_blocked') {
            throw new ControlPlaneServiceError('conflict', error.message, { details: error.details, cause: error });
          }
          throw new ControlPlaneServiceError('invalid_transition', error.message, { details: error.details, cause: error });
        }
        if (error.code === 'terminal_run') throw new ControlPlaneServiceError('conflict', error.message, { cause: error });
        throw new ControlPlaneServiceError(mapOrchestratorErrorCode(error.code), error.message, { details: error.details, cause: error });
      }
      throw error;
    }
  }

  async recoverRun(input: ServiceRecoverRunInput): Promise<ServiceRecoverRunResult> {
    // Policy decision first, before any state load or mutation.
    const decision = await this.#policy.authorize({
      principal: input.principal,
      action: 'run_recovery.create',
      resource: { kind: 'run_recovery', id: input.runId, path: '/v1/runs/:id/recover' }
    });
    if (!decision.allowed) throw new ControlPlaneServiceError('forbidden', 'Not authorized to recover runs.');

    // Model principals cannot recover runs (maps to 403).
    requireNonModelPrincipal(input.principal);

    if (this.#recovery === undefined) {
      throw persistenceFailed('Recovery is not configured.');
    }
    if (this.#runs.recoverFailedRun === undefined) {
      throw persistenceFailed('Run repository does not support recovery.');
    }
    const recovery = this.#recovery;
    const recoverFailedRun = this.#runs.recoverFailedRun.bind(this.#runs);

    // Load + tenant scope. Missing and cross-tenant both resolve to 404 (no tenant disclosure).
    const run = await this.#runs.findById(input.runId);
    if (run === null || run.tenant !== input.tenant) {
      throw new ControlPlaneServiceError('not_found', `Run '${input.runId}' not found.`);
    }

    // Only a failed terminal run can be recovered.
    if (run.currentStep === 'canceled') {
      throw new ControlPlaneServiceError('conflict', `Run '${input.runId}' was canceled and cannot be recovered.`);
    }
    if (run.currentStep === 'done') {
      throw new ControlPlaneServiceError('conflict', `Run '${input.runId}' is done and cannot be recovered.`);
    }
    if (!run.terminal || run.currentStep !== 'failed') {
      throw new ControlPlaneServiceError('conflict', `Run '${input.runId}' is not a stopped failed run and cannot be recovered.`);
    }

    // The stopped step comes from durable RunStep history.
    let steps: readonly RunStep[];
    try {
      steps = await this.#runSteps.listByRun(run.id);
    } catch (error) {
      throw persistenceFailed('Failed to load run steps.', error);
    }
    const stoppedStep = findStoppedStep(steps);
    if (stoppedStep === null) {
      throw new ControlPlaneServiceError('conflict', `Run '${input.runId}' has no recoverable stopped step.`);
    }

    const stoppedPhase = getRunStepDefinition(stoppedStep.step)?.phase ?? null;

    // Commit detection only matters for omitted mode outside the spec phase.
    let hasCommittedCheckpoints = false;
    if (input.request.mode === undefined && stoppedPhase !== 'spec') {
      try {
        hasCommittedCheckpoints = await recovery.detectCommittedCheckpoints({ run });
      } catch (error) {
        throw persistenceFailed('Failed to detect committed checkpoints.', error);
      }
    }

    let plan;
    try {
      plan = resolveRecoveryPlan({
        stoppedStep,
        ...(input.request.mode !== undefined ? { explicitMode: input.request.mode } : {}),
        hasCommittedCheckpoints
      });
    } catch (error) {
      if (error instanceof RecoveryPlanError) {
        throw new ControlPlaneServiceError('conflict', `Run '${input.runId}' has no recoverable stopped step.`, { cause: error });
      }
      throw error;
    }

    // Materialize the workspace BEFORE reopening the run. A materialization failure leaves
    // the run failed and unchanged.
    let provisioningOutcome: 'present' | 'materialized' | 'none';
    try {
      const result = await recovery.materializeWorkspace({
        run,
        baseKind: plan.baseKind,
        existingWorkspaceBehavior: plan.existingWorkspaceBehavior
      });
      provisioningOutcome = result.provisioningOutcome;
    } catch (error) {
      if (error instanceof RunRecoveryWorkspaceError && error.code === 'run_branch_missing') {
        throw new ControlPlaneServiceError('conflict', 'run_branch_missing', { cause: error });
      }
      throw persistenceFailed('Failed to materialize workspace for recovery.', error);
    }

    // Atomic reopen. Active-run conflict maps to a 409 and leaves the failed run unchanged.
    const reDispatchDefinition = getRunStepDefinition(plan.reDispatchStep);
    if (reDispatchDefinition === null) {
      throw persistenceFailed(`Unknown re-dispatch step '${plan.reDispatchStep}'.`);
    }
    const startedAt = new Date().toISOString();
    let reopened;
    try {
      reopened = await recoverFailedRun({
        runId: run.id,
        reDispatchStep: plan.reDispatchStep,
        runStep: buildEntryRunStep(reDispatchDefinition, startedAt)
      });
    } catch (error) {
      if (isActiveRunConflictError(error)) {
        throw new ControlPlaneServiceError('active_run_conflict', `Active run conflict for run '${input.runId}'.`, { cause: error });
      }
      throw persistenceFailed('Failed to reopen run.', error);
    }

    // Publish a durable/live recovery event (post-commit; non-fatal on failure).
    try {
      const event = createRunRecoveryEvent({
        runId: reopened.run.id,
        mode: plan.mode,
        baseKind: plan.baseKind,
        reDispatchStep: plan.reDispatchStep,
        provisioningOutcome,
        run: mapRunToApiRun(reopened.run),
        runStep: reopened.runStep,
        tenant: reopened.run.tenant
      });
      await this.#events.append({ scope: { runId: reopened.run.id, tenant: reopened.run.tenant }, event });
    } catch {
      // The reopen already committed; losing the live event notification must not fail the call.
    }

    // Admit through the orchestrator's existing dispatch path (queue + concurrency).
    try {
      await this.#orchestrator.admitForDispatch({ runId: reopened.run.id, tenant: reopened.run.tenant });
    } catch {
      // Dispatch admission is best-effort; the run is reopened and will be picked up on tick.
    }

    return runRecoveryResponseSchema.parse({ run: mapRunToApiRun(reopened.run), mode: plan.mode });
  }
}
