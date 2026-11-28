import type { RunTestResultsResponse, SaveTestingGuideResultsRequest, TestingGuide, TestingGuideResults } from '@autocatalyst/api-contract';
import { loadLatestFinalTestingPass, readWorkingTestingGuidePass, testingGuidePassView } from './testing-guide-results.js';
import type { TestingGuideRepository, TestResultRepository } from './domain-repositories.js';
import type { RepairActivityReader } from './pr-ci-repair.js';
import { publicationRecoveryStep } from './pr-publication.js';
import { priceRunSessions } from './session-pricing.js';
import { ArchivedRunRecoveryError, RunTransitionConflictError, FeedbackConcurrentModificationError, type RunReadContext, type TopicRepository } from './domain-repositories.js';
import { hasSpecConvergenceState, publicSpecCheckpoint, recoverableSelectedSpecCheckpoint } from './spec-convergence.js';
import type {
  Artifact,
  CreateConversationWithFirstRunRequest,
  CreateConversationWithFirstRunResponse,
  CreateRunFeedbackRequest,
  Feedback,
  FeedbackResponse,
  FeedbackTarget,
  NonModelPrincipal,
  Principal,
  ProjectIssueLookupResponse,
  IntakeRoutingErrorDetails,
  Run,
  RunListCursor,
  RunStatus,
  RunPullRequestResponse,
  RunPullRequestRefreshResponse,
  RunRecoveryRequest,
  RunRecoveryResponse,
  RunWorkflowResponse,
  RunReplyRequest,
  RunReplyResponse,
  RunSessionListResponse,
  RunSpecResponse,
  RunStep,
  SpecAuthorFrontmatter,
  UpdateRunFeedbackRequest
} from '@autocatalyst/api-contract';
import { createConversationWithFirstRunResponseSchema, feedbackResponseSchema, issueTrackerErrorCodeSchema, pullRequestReconciliationResponseSchema, runFeedbackListResponseSchema, runPullRequestResponseSchema, runPullRequestRefreshPath, runPullRequestRefreshResponseSchema, pullRequestCheckFailedErrorCode, pullRequestCheckFailedMessage, runRecoveryResponseSchema, runReplyResponseSchema, runSessionListResponseSchema, runSpecResponseSchema, runWorkflowPath } from '@autocatalyst/api-contract';
import { runActionResponseSchema, renameRunRequestSchema, type RunActionResponse, type RenameRunRequest, type SetRunStepRequest } from '@autocatalyst/api-contract';
import type { ReconcilePullRequestsResponse } from '@autocatalyst/api-contract';

import { defaultRunWorkflowResolver, resolveRunWorkflow, type RunWorkflowResolver } from './run-workflow-resolver.js';
import { projectRunWorkflow } from './run-workflow-projection.js';

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

import type { ArtifactRepository, FeedbackRepository, ListRunsByTenantFilters, ListRunsByTenantOptions, ProjectRepository, PullRequestRepository, RunRepository, RunStepRepository, RunWorkspaceMetadataRepository, SessionRepository } from './domain-repositories.js';
import type { FeedbackLifecycleDependencies } from './feedback-lifecycle.js';
import { appendFeedbackThreadReply, createArtifactFeedback, FeedbackLifecycleError, reopenFeedback, resolveFeedback } from './feedback-lifecycle.js';
import { SpecAnchorValidationError, validateSpecAnchor } from './spec-anchor-validator.js';
import { reconcileSpecFeedback, type ReconcileSpecFeedbackDependencies } from './spec-anchor-reconciler.js';
import type { IssueReferenceIntakeResolver, ResolvedConversationCreate } from './issue-reference-intake.js';
import { IssueReferenceIntakeError } from './issue-reference-intake.js';
import {
  OrchestratorError,
  type OperatorTransitionInput,
  type OrchestratedConversationResult,
  type OrchestratedRunResult,
  type Orchestrator,
  type OrchestratorErrorCode
} from './orchestrator.js';
import { runOperatorPolicy, type PolicyDecisionPoint, type PolicyResourceDescriptor } from './policy.js';
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
  | 'unknown_test_items'
  | 'invalid_feedback_anchor'
  | 'unsupported_pause'
  | typeof pullRequestCheckFailedErrorCode;

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

export interface ServiceLookupProjectIssueInput {
  readonly principal: Principal;
  readonly projectId: string;
  readonly issueNumber: number;
}

export interface ServiceCreateConversationInput {
  readonly principal: Principal;
  readonly tenant: string;
  readonly request: CreateConversationWithFirstRunRequest;
}

export interface ServiceRunActionInput {
  readonly principal: Principal;
  readonly runId: string;
}

export interface ServiceListRunsInput {
  readonly principal: Principal;
  readonly tenant: string;
  readonly limit?: number;
  /** Ordered-position cursor decoded from the opaque client cursor by the route. */
  readonly cursor?: RunListCursor;
  readonly filters?: ListRunsByTenantFilters;
}

export interface ServiceListRunsResult {
  readonly runs: readonly Run[];
  /** Structured next-page cursor; the route encodes it into the opaque API `nextCursor`. */
  readonly nextCursor?: RunListCursor;
}

export interface ServiceGetRunInput {
  readonly principal: Principal;
  readonly tenant: string;
  readonly runId: string;
}

export interface ServiceGetRunResult {
  readonly run: Run;
}

export interface ServiceGetRunWorkflowInput {
  readonly principal: Principal;
  readonly runId: string;
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
  readonly feedback: readonly FeedbackResponse[];
}

export interface AppendRunFeedbackThreadReplyInput {
  readonly principal: Principal;
  readonly tenant: string;
  readonly runId: string;
  readonly feedbackId: string;
  readonly body: string;
}

export interface ServiceUpdateRunFeedbackInput {
  readonly principal: Principal;
  readonly tenant: string;
  readonly runId: string;
  readonly feedbackId: string;
  readonly request: UpdateRunFeedbackRequest;
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
export type ServiceRefreshRunPullRequestInput = Pick<ServiceGetRunPullRequestInput, 'principal' | 'runId'>;

export interface ServiceListRunSessionsInput {
  readonly principal: Principal;
  readonly tenant: string;
  readonly runId: string;
}

export type ServiceListRunSessionsResult = RunSessionListResponse;

// --- Service interface ---

export interface ControlPlaneService {
  lookupProjectIssue(input: ServiceLookupProjectIssueInput): Promise<ProjectIssueLookupResponse>;
  createConversationWithFirstRun(
    input: ServiceCreateConversationInput
  ): Promise<CreateConversationWithFirstRunResponse>;
  listRuns(input: ServiceListRunsInput): Promise<ServiceListRunsResult>;
  getRun(input: ServiceGetRunInput): Promise<ServiceGetRunResult>;
  getRunWorkflow(input: ServiceGetRunWorkflowInput): Promise<RunWorkflowResponse>;
  listRunSteps(input: ServiceListRunStepsInput): Promise<ServiceListRunStepsResult>;
  subscribeRunEvents(input: ServiceSubscribeRunEventsInput): Promise<RunEventSubscription>;
  replayRunEvents(input: ServiceReplayRunEventsInput): Promise<RunEventReplayResult>;
  tick(input: ServiceTickInput): Promise<ServiceTickResult>;
  getTestingGuideResults(input: ServiceGetRunSpecInput): Promise<TestingGuideResults>;
  saveTestingGuideResults(input: ServiceGetRunSpecInput & { readonly request: SaveTestingGuideResultsRequest }): Promise<TestingGuideResults>;
  listRunTestResults(input: ServiceGetRunSpecInput): Promise<RunTestResultsResponse>;
  getRunTestingGuide(input: ServiceGetRunSpecInput): Promise<TestingGuide>;
  getRunSpec(input: ServiceGetRunSpecInput): Promise<ServiceGetRunSpecResult>;
  createRunFeedback(input: ServiceCreateRunFeedbackInput): Promise<ServiceCreateRunFeedbackResult>;
  listRunFeedback(input: ServiceListRunFeedbackInput): Promise<ServiceListRunFeedbackResult>;
  appendRunFeedbackThreadReply(input: AppendRunFeedbackThreadReplyInput): Promise<FeedbackResponse>;
  updateRunFeedback(input: ServiceUpdateRunFeedbackInput): Promise<FeedbackResponse>;
  replyToRun(input: ServiceReplyToRunInput): Promise<RunReplyResponse>;
  cancelRun(input: ServiceRunActionInput): Promise<RunActionResponse>;
  archiveRun(input: ServiceRunActionInput): Promise<RunActionResponse>;
  unarchiveRun(input: ServiceRunActionInput): Promise<RunActionResponse>;
  setRunStep(input: ServiceRunActionInput & { request: SetRunStepRequest }): Promise<RunActionResponse>;
  renameRun(input: ServiceRunActionInput & { request: RenameRunRequest }): Promise<RunActionResponse>;
  recoverRun(input: ServiceRecoverRunInput): Promise<ServiceRecoverRunResult>;
  reconcilePullRequests(input: ServiceReconcilePullRequestsInput): Promise<ServiceReconcilePullRequestsResult>;
  refreshRunPullRequest(input: ServiceRefreshRunPullRequestInput): Promise<RunPullRequestRefreshResponse>;
  getRunPullRequest(input: ServiceGetRunPullRequestInput): Promise<ServiceGetRunPullRequestResult>;
  listRunSessions(input: ServiceListRunSessionsInput): Promise<ServiceListRunSessionsResult>;
}

// --- Constructor options ---

export interface DefaultControlPlaneServiceOptions {
  readonly workflowResolver?: RunWorkflowResolver;
  readonly orchestrator: Orchestrator;
  readonly runs: RunRepository;
  readonly topics?: TopicRepository;
  readonly runSteps: RunStepRepository;
  readonly events: RunEventStore;
  readonly policy: PolicyDecisionPoint;
  readonly artifacts: ArtifactRepository;
  readonly testingGuides?: TestingGuideRepository;
  readonly testResults?: TestResultRepository;
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
  readonly prActivity?: RepairActivityReader;
}

// --- Implementation ---

function normalizeIntakeFailure(error: unknown, operation: 'lookup' | 'create'): ControlPlaneServiceError {
  if (!(error instanceof IssueReferenceIntakeError)) throw error;

  const read = error.trackerFailure;
  if (!read) {
    return new ControlPlaneServiceError('intake_routing_error', error.message, {
      details: { code: error.code } satisfies IntakeRoutingErrorDetails
    });
  }

  const trackerCode = issueTrackerErrorCodeSchema.safeParse(read.error.code);
  if (!trackerCode.success) {
    return new ControlPlaneServiceError('intake_routing_error', 'Failed to read issue from tracker.', {
      details: { code: 'tracker_read_failed' } satisfies IntakeRoutingErrorDetails
    });
  }
  const code = trackerCode.data;
  if (operation === 'lookup' && code === 'issue_not_found') {
    return new ControlPlaneServiceError('not_found', 'Issue not found.', { details: { resource: 'issue' } });
  }

  const context = read.error.safeDetails;
  const matchesContext = (key: string, value: string | number): boolean =>
    context !== undefined && Object.getOwnPropertyDescriptor(context, key)?.value === value;
  const details: IntakeRoutingErrorDetails = {
    code,
    trackerCode: code,
    ...(matchesContext('provider', read.provider) ? { provider: read.provider } : {}),
    ...(matchesContext('repository', read.repository) ? { repository: read.repository } : {}),
    ...(matchesContext('issueNumber', read.issueNumber) && Number.isFinite(read.issueNumber)
      ? { issueNumber: read.issueNumber }
      : {})
  };
  return new ControlPlaneServiceError('intake_routing_error', `Failed to read issue from tracker: ${code}.`, { details });
}

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

// The human-review gate step a feedback item's target is reviewed at. Reopen only applies its
// revise directive when the run is waiting at this step. docs/pr targets have no gate here.
function gateStepForFeedbackTarget(target: FeedbackTarget): 'spec.human_review' | 'implementation.human_review' | null {
  if (target === 'artifact') return 'spec.human_review';
  if (target === 'implementation') return 'implementation.human_review';
  return null;
}

function persistenceFailed(message: string, cause?: unknown): ControlPlaneServiceError {
  return new ControlPlaneServiceError('persistence_failed', message, cause === undefined ? {} : { cause });
}

function mapImplementationGateMutationError(error: unknown, message: string): ControlPlaneServiceError {
  if (error instanceof OrchestratorError) {
    switch (error.code) {
      case 'conflict':
      case 'unknown_test_items':
        return new ControlPlaneServiceError(error.code, error.message, { details: error.details, cause: error });
      case 'missing_run':
        return new ControlPlaneServiceError('not_found', error.message);
    }
  }
  return persistenceFailed(message, error);
}

async function requireTenantRun(input: {
  readonly runs: RunRepository;
  readonly runId: string;
  readonly tenant: string;
  readonly notFoundMessage?: string;
}): Promise<Run> {
  let run: Run | null;
  try {
    run = await input.runs.findById(input.runId);
  } catch (error) {
    throw persistenceFailed('Failed to load run.', error);
  }
  if (run === null || run.tenant !== input.tenant) {
    throw new ControlPlaneServiceError('not_found', input.notFoundMessage ?? `Run '${input.runId}' not found.`);
  }
  return run;
}

export function requireNonModelPrincipal(
  principal: Principal,
  message = 'Model principals cannot create feedback.'
): NonModelPrincipal {
  if (principal.kind === 'model') {
    throw new ControlPlaneServiceError('unauthorized', message);
  }
  return principal as NonModelPrincipal;
}

// Status is derived from terminality + current step, never stored. This mirrors the SQL status
// predicate in the run repository so list filtering and read responses agree.
function deriveRunStatus(run: Run): RunStatus {
  if (!run.terminal) {
    return 'in_progress';
  }
  switch (run.currentStep) {
    case 'done':
      return 'done';
    case 'failed':
      return 'failed';
    case 'canceled':
      return 'canceled';
    default:
      throw persistenceFailed(`Terminal run '${run.id}' has unexpected step '${run.currentStep}'.`);
  }
}

// The persisted/orchestrator run shape plus the catalog-derived `waitingOn`. This is the shape run
// events carry: it never claims the API-only `status`/`projectId` read fields.
function withDerivedWaitingOn(run: Run): Run {
  const definition = getRunStepDefinition(run.currentStep);
  if (definition === null) {
    throw persistenceFailed(`Unknown run step '${run.currentStep}'.`);
  }
  return { ...run, waitingOn: definition.waitingOn };
}

/**
 * The single source for API-only run row fields. Fills `waitingOn` and `status` from the step
 * catalog, and `projectId` from either a batched list-row value already on the run (set by the
 * repository join) or an explicit single-run lookup. Used by list, get, reply, recover, and PR refresh
 * responses so those row fields agree for the same run. Run events deliberately use
 * {@link withDerivedWaitingOn} instead so they do not claim `status`/`projectId`.
 */
function mapRunToApiRun(run: Run, context?: RunReadContext): Run {
  return {
    ...withDerivedWaitingOn(run),
    status: deriveRunStatus(run),
    ...context
  };
}

export class DefaultControlPlaneService implements ControlPlaneService {
  readonly #orchestrator: Orchestrator;
  readonly #runs: RunRepository;
  readonly #topics: TopicRepository | undefined;
  readonly #workflowResolver: RunWorkflowResolver;
  readonly #runSteps: RunStepRepository;
  readonly #events: RunEventStore;
  readonly #policy: PolicyDecisionPoint;
  readonly #artifacts: ArtifactRepository;
  readonly #testingGuides: TestingGuideRepository | undefined;
  readonly #testResults: TestResultRepository | undefined;
  readonly #feedback: FeedbackRepository;
  readonly #runWorkspaceMetadata: RunWorkspaceMetadataRepository;
  readonly #workspaceFilesystem: WorkspaceFileSystemPort;
  readonly #feedbackLifecycle: FeedbackLifecycleDependencies;
  readonly #projects: ProjectRepository;
  readonly #issueReferenceIntakeResolver: IssueReferenceIntakeResolver;
  readonly #pullRequests: PullRequestRepository;
  readonly #sessions: SessionRepository;
  readonly #recovery: RunRecoveryDependencies | undefined;
  readonly #prActivity: RepairActivityReader | undefined;

  constructor(options: DefaultControlPlaneServiceOptions) {
    this.#orchestrator = options.orchestrator;
    this.#runs = options.runs;
    this.#topics = options.topics;
    this.#workflowResolver = options.workflowResolver ?? defaultRunWorkflowResolver;
    this.#runSteps = options.runSteps;
    this.#events = options.events;
    this.#policy = options.policy;
    this.#artifacts = options.artifacts;
    this.#testingGuides = options.testingGuides;
    this.#testResults = options.testResults;
    this.#feedback = options.feedback;
    this.#runWorkspaceMetadata = options.runWorkspaceMetadata;
    this.#workspaceFilesystem = options.workspaceFilesystem;
    this.#feedbackLifecycle = options.feedbackLifecycle;
    this.#projects = options.projects;
    this.#issueReferenceIntakeResolver = options.issueReferenceIntakeResolver;
    this.#pullRequests = options.pullRequests;
    this.#sessions = options.sessions;
    this.#recovery = options.recovery;
    this.#prActivity = options.prActivity;
  }

  async lookupProjectIssue(input: ServiceLookupProjectIssueInput): Promise<ProjectIssueLookupResponse> {
    const { principal, projectId, issueNumber } = input;
    if (principal.kind === 'model') {
      throw new ControlPlaneServiceError('forbidden', 'Forbidden.');
    }
    const project = await this.#projects.findById(principal.tenantId, projectId);
    if (project === null) {
      throw new ControlPlaneServiceError('not_found', 'Project not found.', { details: { resource: 'project' } });
    }
    try {
      return await this.#issueReferenceIntakeResolver.lookup(project, issueNumber);
    } catch (error) {
      throw normalizeIntakeFailure(error, 'lookup');
    }
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
        `Project '${request.projectId}' is not accessible.`,
        { details: { code: 'project_not_accessible' } satisfies IntakeRoutingErrorDetails }
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
      throw normalizeIntakeFailure(error, 'create');
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
          throw new ControlPlaneServiceError('intake_routing_error', error.message, {
            details: { code: error.code } satisfies IntakeRoutingErrorDetails,
            cause: error
          });
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

    const options: ListRunsByTenantOptions = {
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
      ...(input.filters !== undefined ? { filters: input.filters } : {})
    };

    const page = await this.#runs.listByTenant(input.tenant, options);
    // List rows carry projectId from the repository join; the mapper keeps it.
    const runs = page.runs.map((run) => mapRunToApiRun(run));
    return {
      runs,
      ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {})
    };
  }

  /**
   * Resolve the owning projectId for a single run through topic→conversation in a constant number
   * of queries. A missing topic/conversation is a data-integrity error, not a silent omission.
   * Returns undefined only when the repository implementation does not support resolution (test
   * doubles); production persistence always implements it.
   */
  async #resolveRunContext(run: Run): Promise<RunReadContext | undefined> {
    if (this.#runs.resolveRunContext === undefined && this.#runs.resolveProjectId === undefined) return undefined;
    let context: RunReadContext | null;
    try {
      if (this.#runs.resolveRunContext !== undefined) {
        context = await this.#runs.resolveRunContext(run.id);
      } else {
        const projectId = await this.#runs.resolveProjectId!(run.id);
        context = projectId === null ? null : { projectId };
      }
    } catch (error) {
      throw persistenceFailed('Failed to resolve run context.', error);
    }
    if (context === null) {
      throw persistenceFailed(`Run '${run.id}' has no resolvable project (missing topic or conversation).`);
    }
    return context;
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

    return { run: mapRunToApiRun(run, await this.#resolveRunContext(run)) };
  }

  async getRunWorkflow({ principal, runId }: ServiceGetRunWorkflowInput): Promise<RunWorkflowResponse> {
    const decision = await this.#policy.authorize({
      principal,
      action: 'run_workflow.read',
      resource: { kind: 'run_workflow', id: runId, path: runWorkflowPath }
    });
    if (!decision.allowed) {
      throw new ControlPlaneServiceError('forbidden', 'Not authorized to read run workflows.');
    }
    requireNonModelPrincipal(principal, 'Model principals cannot read run workflows.');

    const run = await requireTenantRun({
      runs: this.#runs, runId, tenant: principal.tenantId, notFoundMessage: 'Run not found.'
    });
    try {
      const workflow = await resolveRunWorkflow({ kind: 'existing_run', run }, this.#workflowResolver);
      if (workflow !== null) return projectRunWorkflow(run.workKind, workflow);
    } catch (error) {
      throw persistenceFailed('Failed to resolve run workflow.', error);
    }
    throw persistenceFailed('Run workflow is unavailable.');
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

    const persisted = await this.#runSteps.listByRun(input.runId);
    const steps = this.#prActivity === undefined ? persisted : await this.#prActivity(run, persisted);
    return { steps: steps.map(step => ({ ...step, checkpointResult: publicSpecCheckpoint(step.checkpointResult) })) };
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

  async getRunTestingGuide(input: ServiceGetRunSpecInput): Promise<TestingGuide> {
    const decision = await this.#policy.authorize({
      principal: input.principal, action: 'run_testing_guide.read',
      resource: { kind: 'run_testing_guide', id: input.runId, path: '/v1/runs/:id/testing-guide' }
    });
    if (!decision.allowed) throw new ControlPlaneServiceError('forbidden', 'Not authorized to read a testing guide.');
    const run = await requireTenantRun({ runs: this.#runs, runId: input.runId, tenant: input.tenant });
    let stored;
    try {
      stored = await this.#testingGuides?.findLatestByRun({ runId: run.id, tenant: run.tenant });
    } catch (error) {
      throw persistenceFailed('Failed to load testing guide.', error);
    }
    if (!stored) throw new ControlPlaneServiceError('not_found', 'Testing guide not found.');
    const { id, runId, revision, instructions, items, createdAt } = stored;
    return { id, runId, revision, instructions, items, createdAt };
  }

  async #authorizeTestingGuideResults(input: ServiceGetRunSpecInput, action: 'read' | 'write'): Promise<void> {
    const decision = await this.#policy.authorize({
      principal: input.principal, action: `run_testing_guide_results.${action}`,
      resource: { kind: 'run_testing_guide_results', id: input.runId, path: '/v1/runs/:id/testing-guide/results' }
    });
    if (!decision.allowed) throw new ControlPlaneServiceError('forbidden', 'Not authorized to access testing guide results.');
  }

  async getTestingGuideResults(input: ServiceGetRunSpecInput): Promise<TestingGuideResults> {
    await this.#authorizeTestingGuideResults(input, 'read');
    const run = await requireTenantRun({ runs: this.#runs, runId: input.runId, tenant: input.tenant });
    const guides = this.#testingGuides;
    const results = this.#testResults;
    if (!guides || !results) throw persistenceFailed('Testing results are unavailable.');
    const scope = { runId: run.id, tenant: run.tenant };
    try {
      if (run.currentStep === 'implementation.human_review') {
        const guide = await guides.findLatestByRun(scope);
        if (guide === null) throw new ControlPlaneServiceError('not_found', 'Testing guide not found.');
        const gate = await this.#runs.findLatestOpenRunStep?.({ runId: run.id, step: run.currentStep });
        if (!gate) throw new ControlPlaneServiceError('conflict', 'The implementation review occurrence changed.');
        return await readWorkingTestingGuidePass(guide, gate.id, run.tenant, guides, results);
      }
      const final = await loadLatestFinalTestingPass(scope, guides, results);
      if (final === null) throw new ControlPlaneServiceError('not_found', 'No test result is recorded for this run.');
      return testingGuidePassView(final.guide, final.result);
    } catch (error) {
      if (error instanceof ControlPlaneServiceError) throw error;
      throw persistenceFailed('Failed to load testing results.', error);
    }
  }

  async saveTestingGuideResults(input: ServiceGetRunSpecInput & { readonly request: SaveTestingGuideResultsRequest }): Promise<TestingGuideResults> {
    await this.#authorizeTestingGuideResults(input, 'write');
    const principal = requireNonModelPrincipal(input.principal, 'Model principals cannot save testing results.');
    const run = await requireTenantRun({ runs: this.#runs, runId: input.runId, tenant: input.tenant });
    try {
      if (!this.#orchestrator.saveTestingGuideResults) throw persistenceFailed('Testing results are unavailable.');
      return await this.#orchestrator.saveTestingGuideResults({ ...input, runId: run.id, principal });
    } catch (error) {
      throw mapImplementationGateMutationError(error, 'Failed to save testing results.');
    }
  }

  async listRunTestResults(input: ServiceGetRunSpecInput): Promise<RunTestResultsResponse> {
    const decision = await this.#policy.authorize({
      principal: input.principal, action: 'run_test_results.list',
      resource: { kind: 'run_test_results', id: input.runId, path: '/v1/runs/:id/test-results' }
    });
    if (!decision.allowed) throw new ControlPlaneServiceError('forbidden', 'Not authorized to list test results.');
    const run = await requireTenantRun({ runs: this.#runs, runId: input.runId, tenant: input.tenant });
    try {
      if (!this.#testResults) throw persistenceFailed('Testing results are unavailable.');
      return { testResults: [...await this.#testResults.listByRun(run.id)] };
    } catch (error) {
      throw persistenceFailed('Failed to list run test results.', error);
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

    const { artifact, markdown, frontmatter } = await this.#readCurrentSpec(run);
    return runSpecResponseSchema.parse({ artifact, markdown, frontmatter });
  }

  /**
   * Shared current-spec reader used by {@link getRunSpec} and spec-anchor validation/reconciliation.
   * Returns the current spec artifact, its committed markdown, and parsed frontmatter while
   * preserving `GET /v1/runs/:id/spec` failure semantics: a run whose work kind has no spec, or a
   * run with no spec artifact, is `not_found` (404); an unreadable or unparseable spec file is a
   * persistence failure (500), not a 404.
   */
  async #readCurrentSpec(run: Run): Promise<{ artifact: Artifact; markdown: string; frontmatter: SpecAuthorFrontmatter }> {
    const artifactKind = specArtifactKindForRun(run.workKind);
    if (artifactKind === null) {
      throw new ControlPlaneServiceError('not_found', `Run work kind '${run.workKind}' does not support spec reads.`);
    }

    const artifact = await this.#artifacts.findByRunAndKind({ runId: run.id, kind: artifactKind });
    if (artifact === null) {
      throw new ControlPlaneServiceError('not_found', `No spec artifact found for run '${run.id}'.`);
    }
    if (artifact.canonicalRecord !== 'file') {
      throw new ControlPlaneServiceError('not_found', `Spec artifact for run '${run.id}' is not file-canonical.`);
    }

    let workspaceMetadata;
    try {
      workspaceMetadata = await this.#runWorkspaceMetadata.findByRunId(run.id);
    } catch (error) {
      throw persistenceFailed('Failed to load workspace metadata.', error);
    }
    if (workspaceMetadata === null) {
      throw persistenceFailed('Run workspace metadata is not available.');
    }

    let markdown: string;
    try {
      markdown = await this.#workspaceFilesystem.readFile({
        workspaceRepoRoot: workspaceMetadata.workspaceRepoRoot,
        relativePath: artifact.location
      });
    } catch (error) {
      throw persistenceFailed('Failed to read spec file.', error);
    }

    let frontmatter: SpecAuthorFrontmatter;
    try {
      frontmatter = parseSpecFrontmatter(markdown);
    } catch (error) {
      throw persistenceFailed('Failed to parse spec frontmatter.', error);
    }

    return { artifact, markdown, frontmatter };
  }

  /**
   * Reconcile spec feedback anchors for a read response (list, thread-reply, PATCH). Reads the spec
   * at most once, only when an eligible anchor exists, persists repaired offsets when the repository
   * supports it, and degrades to stored-unreconciled items when the spec cannot be read.
   */
  async #reconcileFeedbackForResponse(run: Run, items: readonly Feedback[]): Promise<readonly FeedbackResponse[]> {
    const deps: ReconcileSpecFeedbackDependencies = {
      runId: run.id,
      readCurrentSpec: async () => {
        try {
          const { artifact, markdown } = await this.#readCurrentSpec(run);
          return { artifactId: artifact.id, markdown };
        } catch {
          // Any failure (no spec artifact, unreadable file) degrades the read to unreconciled.
          return null;
        }
      },
      ...(this.#feedback.updateAnchorOffsets !== undefined
        ? {
            persistRepairedOffsets: async ({ feedbackId, from, to }) => {
              await this.#feedback.updateAnchorOffsets!({ feedbackId, from, to });
            }
          }
        : {})
    };
    return reconcileSpecFeedback(items, deps);
  }

  /**
   * Validate a present spec feedback anchor against the current spec. No-op when the anchor is
   * absent (unanchored feedback is accepted without reading the spec). Maps a validation failure to
   * an `invalid_feedback_anchor` service error (422) carrying the typed reason. A missing spec
   * artifact surfaces as the same 404 as `GET /v1/runs/:id/spec`; an unreadable spec file is the
   * existing persistence failure.
   */
  async #validateSpecAnchorIfPresent(run: Run, anchor: Feedback['anchor']): Promise<void> {
    if (anchor === undefined) return;
    const { artifact, markdown } = await this.#readCurrentSpec(run);
    try {
      validateSpecAnchor({ anchor, currentSpec: { artifactId: artifact.id, markdown } });
    } catch (error) {
      if (error instanceof SpecAnchorValidationError) {
        throw new ControlPlaneServiceError('invalid_feedback_anchor', error.message, {
          details: { reason: error.reason }
        });
      }
      throw error;
    }
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

    if (input.request.target === 'implementation') {
      try {
        if (!this.#orchestrator.createImplementationFeedback) throw persistenceFailed('Implementation feedback is unavailable.');
        return await this.#orchestrator.createImplementationFeedback({
          runId: run.id, tenant: run.tenant, principal: author, title: input.request.title, body: input.request.body
        });
      } catch (error) {
        throw mapImplementationGateMutationError(error, 'Failed to create implementation feedback.');
      }
    }

    // A present spec anchor is validated against the current spec before any item is created. An
    // absent anchor is accepted without reading the spec (target-level feedback).
    await this.#validateSpecAnchorIfPresent(run, input.request.anchor);

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

    const reconciled = await this.#reconcileFeedbackForResponse(run, feedbackItems);
    return runFeedbackListResponseSchema.parse({ feedback: reconciled });
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

    let updated: Feedback;
    try {
      updated = await appendFeedbackThreadReply({
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

    // Single-item responses pass through the same reconciler as list reads so a client never
    // replaces a cached item with an older range than a list read would have returned.
    const [reconciled] = await this.#reconcileFeedbackForResponse(run, [updated]);
    return feedbackResponseSchema.parse(reconciled ?? updated);
  }

  async updateRunFeedback(input: ServiceUpdateRunFeedbackInput): Promise<FeedbackResponse> {
    // Policy decision FIRST, before loading or mutating any feedback, so cross-run item existence
    // is never leaked and no mutation happens before authorization.
    const decision = await this.#policy.authorize({
      principal: input.principal,
      action: 'run_feedback.update',
      resource: { kind: 'run_feedback_item', id: input.runId, path: '/v1/runs/:id/feedback/:feedbackId' }
    });
    if (!decision.allowed) {
      throw new ControlPlaneServiceError('forbidden', 'Not authorized to update run feedback.');
    }

    // Model principals are authors, not operators, for this route (maps to 403).
    const actor = requireNonModelPrincipal(input.principal);
    if (input.request.status === 'wont_fix' && actor.kind !== 'human') {
      throw new ControlPlaneServiceError('forbidden', 'Only a human can decline a model finding.');
    }

    // Load + tenant-scope the run. Missing and cross-tenant both resolve to 404.
    const run = await this.#runs.findById(input.runId);
    if (run === null || run.tenant !== input.tenant) {
      throw new ControlPlaneServiceError('not_found', `Run '${input.runId}' not found.`);
    }

    // Load the feedback. A missing item, or an item from another run/tenant, is 404 (no cross-run
    // existence disclosure).
    let feedback: Feedback | null;
    try {
      feedback = await this.#feedback.findById(input.feedbackId);
    } catch (error) {
      throw persistenceFailed('Failed to load feedback.', error);
    }
    if (feedback === null || feedback.tenant !== input.tenant || feedback.runId !== run.id) {
      throw new ControlPlaneServiceError('not_found', 'Feedback not found.');
    }

    const request = input.request;

    if (request.status === 'wont_fix') {
      if (!this.#orchestrator.declineSpecFinding) {
        throw new ControlPlaneServiceError('conflict', 'Bounded spec review is not active.');
      }
      try {
        const updated = await this.#orchestrator.declineSpecFinding({
          runId: input.runId, tenant: input.tenant, feedbackId: input.feedbackId, principal: actor, body: request.body
        });
        return feedbackResponseSchema.parse(updated);
      } catch (error) {
        if (error instanceof OrchestratorError && error.code === 'missing_run') {
          throw new ControlPlaneServiceError('not_found', error.message);
        }
        if ((error instanceof OrchestratorError && error.code === 'invalid_transition') ||
            error instanceof FeedbackConcurrentModificationError) {
          throw new ControlPlaneServiceError('conflict', 'The finding is no longer eligible to be declined.');
        }
        throw error;
      }
    }

    if (request.status === 'resolved') {
      const result = await this.#resolveViaLifecycle(input.feedbackId, actor, request.body);
      const [reconciled] = await this.#reconcileFeedbackForResponse(run, [result]);
      return feedbackResponseSchema.parse(reconciled ?? result);
    }

    // status === 'open' (reopen).
    if (request.body === undefined || request.body.length === 0) {
      throw new ControlPlaneServiceError('invalid_transition', 'Reopening a feedback item requires an explanatory body.');
    }

    // Reopen only applies at the gate for the item's target; otherwise 409 and nothing changes.
    const gateStep = gateStepForFeedbackTarget(feedback.target);
    if (gateStep === null || run.terminal || run.currentStep !== gateStep) {
      throw new ControlPlaneServiceError('conflict', `Run '${input.runId}' is not waiting at the gate for this feedback target; reopen is not applicable.`);
    }

    const reopened = await this.#reopenViaLifecycle(input.feedbackId, actor, request.body);

    // Send the run back to revise for the reopened item's target.
    try {
      await this.#orchestrator.applyDirective({
        runId: run.id,
        tenant: run.tenant,
        directive: 'revise',
        origin: 'human',
        principal: actor
      });
    } catch (error) {
      if (error instanceof OrchestratorError) {
        throw new ControlPlaneServiceError('conflict', error.message, {
          ...(error.details !== undefined ? { details: error.details } : {}),
          cause: error
        });
      }
      throw error;
    }

    const [reconciled] = await this.#reconcileFeedbackForResponse(run, [reopened]);
    return feedbackResponseSchema.parse(reconciled ?? reopened);
  }

  async #resolveViaLifecycle(feedbackId: string, actor: NonModelPrincipal, body?: string): Promise<Feedback> {
    try {
      return await resolveFeedback(
        { feedbackId, actor, ...(body !== undefined ? { body } : {}) },
        this.#feedbackLifecycle
      );
    } catch (error) {
      throw this.#mapFeedbackLifecycleError(error);
    }
  }

  async #reopenViaLifecycle(feedbackId: string, actor: NonModelPrincipal, body: string): Promise<Feedback> {
    try {
      return await reopenFeedback({ feedbackId, actor, body }, this.#feedbackLifecycle);
    } catch (error) {
      throw this.#mapFeedbackLifecycleError(error);
    }
  }

  #mapFeedbackLifecycleError(error: unknown): ControlPlaneServiceError {
    if (error instanceof FeedbackLifecycleError) {
      switch (error.code) {
        case 'feedback_missing':
          return new ControlPlaneServiceError('not_found', 'Feedback not found.');
        case 'feedback_not_originator':
          return new ControlPlaneServiceError('forbidden', error.message);
        case 'feedback_invalid_transition':
          return new ControlPlaneServiceError('conflict', error.message);
        case 'feedback_invalid_input':
          return new ControlPlaneServiceError('invalid_transition', error.message);
      }
    }
    return persistenceFailed('Failed to update feedback.', error);
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
      return pullRequestReconciliationResponseSchema.parse(await this.#orchestrator.detectMerges(input.tenant, true));
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

  async refreshRunPullRequest(input: ServiceRefreshRunPullRequestInput): Promise<RunPullRequestRefreshResponse> {
    const { principal, runId } = input;
    const decision = await this.#policy.authorize({
      principal,
      action: 'run_pull_request.refresh',
      resource: { kind: 'run_pull_request_refresh', id: runId, path: runPullRequestRefreshPath }
    });
    if (!decision.allowed || principal.kind === 'model') {
      throw new ControlPlaneServiceError('forbidden', 'Forbidden.');
    }

    let result;
    try {
      result = await this.#orchestrator.refreshRunPullRequest({ runId, tenant: principal.tenantId });
    } catch {
      throw persistenceFailed('Failed to refresh run pull request.');
    }
    switch (result.kind) {
      case 'not_found':
        throw new ControlPlaneServiceError('not_found', result.resource === 'run'
          ? `Run '${runId}' not found.`
          : `Pull request for run '${runId}' not found.`);
      case 'conflict':
        throw new ControlPlaneServiceError('conflict', result.message);
      case 'read_failed':
        throw new ControlPlaneServiceError(pullRequestCheckFailedErrorCode, pullRequestCheckFailedMessage, {
          details: { reason: result.reason }
        });
      case 'internal_failure':
        throw persistenceFailed('Failed to refresh run pull request.');
      case 'refreshed':
        try {
          return runPullRequestRefreshResponseSchema.parse({
            pullRequest: result.pullRequest,
            run: mapRunToApiRun(result.run, await this.#resolveRunContext(result.run))
          });
        } catch {
          throw persistenceFailed('Failed to project refreshed run pull request.');
        }
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

    try {
      const snapshot = this.#sessions.readPricingSnapshot === undefined
        ? { sessions: await this.#sessions.listByRun(input.runId), history: [] }
        : await this.#sessions.readPricingSnapshot(input.tenant, input.runId);
      return runSessionListResponseSchema.parse(priceRunSessions(snapshot.sessions, snapshot.history));
    } catch (error) {
      throw persistenceFailed('Failed to list run sessions.', error);
    }
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
    if (input.request.kind !== 'guidance' && stepDefinition?.waitingOn !== 'human') throw new ControlPlaneServiceError('conflict', `Run '${input.runId}' is not waiting on human input.`);

    // At the spec review gate, a present anchor on a feedback reply is validated against the current
    // spec before the orchestrator creates an item or applies a directive. Rejection leaves the run
    // at the gate and creates no item. Implementation-gate feedback replies keep arbitrary optional
    // anchors unchanged and are not validated here.
    if (
      input.request.kind === 'feedback' &&
      input.request.anchor !== undefined &&
      run.currentStep === 'spec.human_review'
    ) {
      await this.#validateSpecAnchorIfPresent(run, input.request.anchor);
    }

    try {
      const result = await this.#orchestrator.replyToRun({
        runId: input.runId,
        tenant: input.tenant,
        principal,
        request: input.request
      });
      const context = await this.#resolveRunContext(result.run);
      return runReplyResponseSchema.parse({ run: mapRunToApiRun(result.run, context), classification: result.classification });
    } catch (error) {
      if (error instanceof OrchestratorError) {
        if (error.details !== null && typeof error.details === 'object' && (error.details as { code?: unknown }).code === 'unsupported_pause') {
          throw new ControlPlaneServiceError('unsupported_pause', 'Unsupported human pause.', { cause: error });
        }
        if (error.code === 'invalid_transition') {
          const details = error.details as { code?: unknown } | null;
          if (details !== null && typeof details === 'object' && (details.code === 'feedback_gate_blocked' || details.code === 'failed_test_items' || details.code === 'request_changes_conflict' || details.code === 'stale_pause')) {
            throw new ControlPlaneServiceError('conflict', error.message, { details: error.details, cause: error });
          }
          throw new ControlPlaneServiceError('invalid_transition', error.message, { details: error.details, cause: error });
        }
        if (error.code === 'terminal_run' || error.code === 'conflict') throw new ControlPlaneServiceError('conflict', error.message, { details: error.details, cause: error });
        throw new ControlPlaneServiceError(mapOrchestratorErrorCode(error.code), error.message, { details: error.details, cause: error });
      }
      throw error;
    }
  }

  async #authorizeRunAction(input: ServiceRunActionInput, name: keyof typeof runOperatorPolicy) {
    const { principal, runId } = input;
    const { action, ...descriptor } = runOperatorPolicy[name];
    const decision = await this.#policy.authorize({ principal, action, resource: { ...descriptor, id: runId } });
    if (!decision.allowed) throw new ControlPlaneServiceError('forbidden', 'Forbidden.');
    return requireNonModelPrincipal(principal, 'Model principals cannot perform run operator actions.');
  }

  #runActionNotFound(runId: string): never {
    throw new ControlPlaneServiceError('not_found', `Run '${runId}' not found.`);
  }

  async #projectRunAction(run: Run): Promise<RunActionResponse> {
    return runActionResponseSchema.parse({ run: mapRunToApiRun(run, await this.#resolveRunContext(run)) });
  }

  async #applyOperatorTransition(
    input: ServiceRunActionInput,
    name: 'cancelRun' | 'setRunStep',
    transition: (mutation: OperatorTransitionInput) => Promise<OrchestratedRunResult>
  ): Promise<RunActionResponse> {
    const principal = await this.#authorizeRunAction(input, name);
    const mutation = { runId: input.runId, tenant: principal.tenantId, principal };
    try {
      const result = await transition(mutation);
      return this.#projectRunAction(result.run);
    } catch (error) {
      if (!(error instanceof OrchestratorError)) throw error;
      if (error.code === 'missing_run') this.#runActionNotFound(input.runId);
      const code = error.code === 'terminal_run' || error.code === 'conflict' ? 'conflict'
        : error.code === 'invalid_transition' ? 'invalid_transition' : 'persistence_failed';
      throw new ControlPlaneServiceError(code, error.message, { cause: error, details: error.details });
    }
  }

  cancelRun(input: ServiceRunActionInput) {
    return this.#applyOperatorTransition(input, 'cancelRun', (mutation) => this.#orchestrator.cancelRun(mutation));
  }

  setRunStep(input: ServiceRunActionInput & { request: SetRunStepRequest }) {
    return this.#applyOperatorTransition(input, 'setRunStep',
      (mutation) => this.#orchestrator.setRunStep({ ...mutation, step: input.request.step }));
  }

  async #setRunArchived(input: ServiceRunActionInput, archive: boolean) {
    const principal = await this.#authorizeRunAction(input, archive ? 'archiveRun' : 'unarchiveRun');
    if (this.#runs.setArchived === undefined) throw persistenceFailed('Archive storage not configured.');
    const run = await this.#runs.setArchived(input.runId, principal.tenantId, archive ? new Date().toISOString() : null);
    if (run === null) this.#runActionNotFound(input.runId);
    if (archive && run.archivedAt === undefined) {
      const reason = 'Only finished runs can be archived.';
      throw new ControlPlaneServiceError('conflict', reason, { details: { reason } });
    }
    return this.#projectRunAction(run);
  }

  archiveRun(input: ServiceRunActionInput) {
    return this.#setRunArchived(input, true);
  }

  unarchiveRun(input: ServiceRunActionInput) {
    return this.#setRunArchived(input, false);
  }

  async renameRun(input: ServiceRunActionInput & { request: RenameRunRequest }) {
    const principal = await this.#authorizeRunAction(input, 'renameRun');
    const run = await this.#runs.findById(input.runId);
    if (run === null || run.tenant !== principal.tenantId) this.#runActionNotFound(input.runId);
    if (this.#topics?.updateTitle === undefined) throw persistenceFailed('Topic title storage not configured.');
    const { title } = renameRunRequestSchema.parse(input.request);
    const topic = await this.#topics.updateTitle(principal.tenantId, run.topicId, title);
    if (topic === null) throw persistenceFailed('Run topic missing during rename.');
    const context = await this.#resolveRunContext(run);
    return runActionResponseSchema.parse({ run: { ...mapRunToApiRun(run, context), title: topic.title } });
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

    if (run.archivedAt !== undefined) {
      const reason = new ArchivedRunRecoveryError().message;
      throw new ControlPlaneServiceError('conflict', reason, { details: { reason } });
    }

    if (this.#recovery === undefined) {
      throw persistenceFailed('Recovery is not configured.');
    }
    if (this.#runs.recoverFailedRun === undefined) {
      throw persistenceFailed('Run repository does not support recovery.');
    }
    const recovery = this.#recovery;

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

    if (await this.#orchestrator.workspaceHeld?.({ runId: run.id, tenant: run.tenant })) {
      throw new ControlPlaneServiceError('conflict', 'The workspace is held for authorized host inspection.');
    }

    const stoppedPhase = getRunStepDefinition(stoppedStep.step)?.phase ?? null;

    // Commit detection only matters for omitted mode outside the spec phase.
    let hasCommittedCheckpoints = false;
    if (input.request.mode === undefined && stoppedPhase !== 'spec' && !publicationRecoveryStep(stoppedStep, run.failureReason ?? undefined)) {
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
        ...(run.failureReason != null ? { failureReason: run.failureReason } : {}),
        ...(input.request.mode !== undefined ? { explicitMode: input.request.mode } :
          stoppedStep.step === 'spec.author' && recoverableSelectedSpecCheckpoint(stoppedStep.checkpointResult)
            ? { explicitMode: 'resume' } : {}),
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
      reopened = await this.#orchestrator.reopenFailedRun({
        runId: run.id,
        reDispatchStep: plan.reDispatchStep,
        runStep: buildEntryRunStep(reDispatchDefinition, startedAt),
        ...(plan.mode === 'resume' && plan.reDispatchStep === 'spec.author' &&
          hasSpecConvergenceState(stoppedStep.checkpointResult) && stoppedStep.checkpointResult !== null
          ? { destinationCheckpointResult: stoppedStep.checkpointResult } :
          plan.reDispatchStep === 'pr.finalize' &&
            (plan.mode === 'start_over' || publicationRecoveryStep(stoppedStep, run.failureReason ?? undefined))
            ? { destinationCheckpointResult: { kind: 'publication_recovery_epoch' } } : {})
      }, input.tenant);
    } catch (error) {
      if (isActiveRunConflictError(error)) {
        throw new ControlPlaneServiceError('active_run_conflict', `Active run conflict for run '${input.runId}'.`, { cause: error });
      }
      if (error instanceof ArchivedRunRecoveryError || error instanceof RunTransitionConflictError) {
        const reason = error instanceof ArchivedRunRecoveryError ? error.message : 'Run is no longer a stopped failed run.';
        throw new ControlPlaneServiceError('conflict', reason, { details: { reason }, cause: error });
      }
      throw persistenceFailed('Failed to reopen run.', error);
    }

    const recoveredContext = await this.#resolveRunContext(reopened.run);

    // Publish a durable/live recovery event (post-commit; non-fatal on failure).
    try {
      const event = createRunRecoveryEvent({
        runId: reopened.run.id,
        mode: plan.mode,
        baseKind: plan.baseKind,
        reDispatchStep: plan.reDispatchStep,
        provisioningOutcome,
        // Run events carry the persisted+waitingOn shape only, never status/projectId.
        run: withDerivedWaitingOn(reopened.run),
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

    return runRecoveryResponseSchema.parse({ run: mapRunToApiRun(reopened.run, recoveredContext), mode: plan.mode });
  }
}
