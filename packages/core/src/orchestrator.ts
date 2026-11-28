import { assignTestingGuideItemIds, authorTestingGuide } from './testing-guide.js';
import { failedTestingItemFeedbackBody, patchTestingGuideItems, readWorkingTestingGuidePass, testingGuidePassView } from './testing-guide-results.js';
import { TestingGuidePassConflictError, type TestingGuidePassDecision, type TestResultRepository } from './domain-repositories.js';
import type { StoredTestingGuide, TestingGuideRepository } from './domain-repositories.js';
import { ArchivedRunRecoveryError, RunTransitionConflictError } from './domain-repositories.js';
import { workflowOwnedSteps } from './run-transition.js';
import { StaleDispatchError, type CommitDispatchResult } from './dispatch-result-commits.js';
import { convergenceCheckpointSchema } from '@autocatalyst/api-contract';
import { randomUUID } from 'node:crypto';
import { findCurrentRepair, type RepairDecision, type RepairMove, type RepairRepository } from './pr-ci-repair.js';
import { executeRepair, recoverRepairAttempt, repairTerminalMove, type RepairWorkerDependencies } from './pr-repair-worker.js';
import { readPullRequest } from './pr-lifecycle.js';
import type { Feedback } from '@autocatalyst/api-contract';
import { eligibleSpecFinding, publicSpecCheckpoint, type SpecQuestionPause } from './spec-convergence.js';
import type {
  ChannelReference,
  Conversation,
  JsonValue,
  Message,
  NonModelPrincipal,
  Run,
  RunReplyClassification,
  RunReplyRequest,
  RunStateTransitionKind,
  RunStep,
  SpecAuthorResult,
  TestingGuideResult,
  SaveTestingGuideResultsRequest,
  TestingGuideResults,
  Topic,
  TrackedIssue
} from '@autocatalyst/api-contract';

import { normalizeFailureReasonForPublicSurface } from '@autocatalyst/execution';

import type { CompleteSpecAuthoringOutput, SpecAuthoringServiceDependencies } from './spec-authoring-service.js';
import { completeSpecAuthoring } from './spec-authoring-service.js';
import type { SpecApprovalFinalizerDependencies } from './spec-approval-finalizer.js';
import { finalizeSpecApproval } from './spec-approval-finalizer.js';
import type { SpecFreezeDependencies } from './spec-freeze.js';
import { freezeRunSpecForPullRequest, SpecFreezeError } from './spec-freeze.js';
import type { ConvergenceEngine } from './convergence-engine.js';
import {
  buildPullRequestFinalizeCheckpoint,
  feedbackInputsFromPullRequestFinalizeFindings
} from './pr-finalize.js';
import { validatePullRequestFinalizeResult } from './pr-finalize-result-validation.js';
import {
  ConvergenceCheckpointError,
  buildConvergenceEscalationPause,
  getConvergenceEscalationPause
} from './convergence-checkpoint.js';

import type {
  ConversationIngressRepository,
  ConversationRepository,
  CreateConversationTopicMessageAndRunResult,
  LifecycleRunStepInput,
  ProjectRepository,
  PullRequestRepository,
  RecoverFailedRunInput,
  RecoverFailedRunResult,
  RunRepository,
  RunStepRepository,
  RunWorkspaceMetadataRepository,
  TopicRepository
} from './domain-repositories.js';
import type { ResolveCodeHostCredential } from './code-host.js';
import type { CodeHostRegistry } from './code-host-registry.js';
import type { RunWorkspaceGitPort } from './run-workspace-git.js';
import { handlePullRequestOpen } from './pr-open-handler.js';
import { initialPullRequestBase, publicationEpoch, resolvePublicationBinding, type PublicationGitPort } from './pr-publication.js';
import { buildCumulativeImplementationSummary, buildImplementationSummaryRoundInputs } from './implementation-summary.js';
import {
  detectPullRequestMerges,
  refreshPullRequest,
  type PullRequestStatusReconciliationResult,
  type RefreshPullRequestDependencies,
  type RefreshPullRequestOutcome
} from './pr-lifecycle.js';
import type { FeedbackLifecycleDependencies } from './feedback-lifecycle.js';
import { buildGateFeedback, createGateFeedback, listBlockingFeedback, resolveApproverAddressedFeedback } from './feedback-lifecycle.js';
import { assertSpecReviewGateCanAdvance, SpecReviewGateBlockedError } from './spec-review-gate.js';
import {
  assertHumanReviewGateCanAdvance,
  getHumanReviewGateFeedbackTarget,
  isHumanReviewGateStep,
  HumanReviewGateError
} from './human-review-gate.js';
import { type RunDispatchQueue } from './run-dispatch-queue.js';
import { createRunStateTransitionEvent, type RunEventStore } from './run-events.js';
import {
  applyRunDirective,
  buildEntryRunStep,
  requireRunWorkflow,
  RunLifecycleError,
  startRunLifecycle,
  type RunLifecycleState
} from './run-lifecycle.js';
import { deriveRunTerminal, getRunStepDefinition, type RunStepDefinition } from './run-step-catalog.js';
import type { RunDirective, RunWorkflowDefinition } from './run-workflows.js';
import { defaultRunWorkflowResolver, type RunWorkflowResolver, type RunWorkflowResolverInput } from './run-workflow-resolver.js';
import { safeFailureReasonFromError } from './safe-failure-reason.js';

// --- Error types ---

export type OrchestratorErrorCode =
  | 'active_run_conflict'
  | 'missing_run'
  | 'terminal_run'
  | 'conflict'
  | 'invalid_transition'
  | 'unknown_work_kind'
  | 'forbidden'
  | 'persistence_failed'
  | 'unknown_test_items';

export interface ActiveRunConflictDetails {
  readonly topicId: string;
  readonly existingRunId: string | null;
}

export interface OrchestratorErrorOptions {
  readonly details?: unknown;
  readonly cause?: unknown;
}

export class OrchestratorError extends Error {
  readonly code: OrchestratorErrorCode;
  readonly details?: unknown;
  override readonly cause?: unknown;

  constructor(code: OrchestratorErrorCode, message: string, options: OrchestratorErrorOptions = {}) {
    super(message);
    this.name = 'OrchestratorError';
    this.code = code;
    if (options.details !== undefined) this.details = options.details;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

// --- Unit of work ---

export interface RunWorkInput {
  readonly signal?: AbortSignal;
  readonly runId: string;
  readonly run: Run;
  readonly tenant: string;
  readonly toolPolicyMode?: 'read_only' | 'write';
  readonly testingGuidePass?: number;
  readonly previousTestingGuide?: StoredTestingGuide;
  readonly testingGuideCorrection?: string;
  readonly publicationReview?: import('./pr-finalize.js').PublicationReviewSnapshot;
}

export type CancelledWorkResult = { readonly directive: 'cancelled' };

export type RunWorkResult =
  | CancelledWorkResult
  | { readonly directive: 'advance'; readonly result?: Readonly<Record<string, unknown>> }
  | { readonly directive: 'needs_input'; readonly question?: string }
  | { readonly directive: 'fail'; readonly reason: string };

export interface RunUnitOfWork {
  run(input: RunWorkInput): Promise<RunWorkResult>;
}

// --- Input/result types ---

export interface CreateOrchestratedRunInput {
  readonly topicId: string;
  readonly owner: NonModelPrincipal;
  readonly tenant: string;
  readonly workKind: string;
  readonly trackedIssue?: TrackedIssue;
  readonly testingGuideResult?: TestingGuideResult;
}

export interface CreateOrchestratedConversationInput {
  readonly projectId: string;
  readonly owner: NonModelPrincipal;
  readonly tenant: string;
  readonly identity: string;
  readonly channel?: ChannelReference;
  readonly topic: { readonly title: string };
  readonly message?: {
    readonly body: string;
    readonly intent?: string;
  };
  readonly workKind: string;
  readonly trackedIssue?: TrackedIssue;
  readonly testingGuideResult?: TestingGuideResult;
}

export interface ApplyOrchestratedDirectiveInput {
  readonly runId: string;
  readonly directive: RunDirective;
  readonly tenant: string;
  readonly checkpointResult?: JsonValue;
  readonly destinationCheckpointResult?: JsonValue;
  readonly principal?: NonModelPrincipal;
  readonly reason?: string;
  readonly origin?: 'runner' | 'human' | 'system';
  readonly refreshPublication?: true;
  readonly expectedStepId?: string;
  readonly publicationProvenance?: { readonly pullRequestId: string; readonly headSha: string };
}

export interface OperatorTransitionInput extends DispatchRunInput {
  readonly principal: NonModelPrincipal;
}

interface DispatchSource {
  readonly run: Run;
  readonly runStep: RunStep | null;
}

interface DispatchReservation extends DispatchSource {
  readonly automatic: boolean;
  readonly result: Promise<OrchestratedRunResult>;
  readonly resolve: (result: OrchestratedRunResult) => void;
  readonly reject: (error: unknown) => void;
  continuation?: DispatchSource;
  controller?: AbortController;
}

type CommitDispatchTransition = (
  work: (apply: Orchestrator['applyDirective']) => Promise<OrchestratedRunResult>
) => Promise<OrchestratedRunResult>;

type ApplyLockedDirective = (
  input: ApplyOrchestratedDirectiveInput,
  source?: DispatchSource,
  decision?: TestingGuidePassDecision
) => Promise<OrchestratedRunResult>;

export interface DispatchRunInput {
  readonly runId: string;
  readonly tenant: string;
}

export interface TickInput {
  readonly runId?: string;
  readonly tenant: string;
}

export type TickResult =
  | { readonly status: 'noop' }
  | { readonly status: 'dispatched'; readonly runId: string };

export interface OrchestratedRunResult {
  readonly run: Run;
  readonly runStep: RunStep;
}

export interface OrchestratedConversationResult {
  readonly conversation: Conversation;
  readonly topic: Topic;
  readonly message?: Message;
  readonly run: Run;
  readonly runStep: RunStep;
}

export interface ReplyToRunInput {
  readonly runId: string;
  readonly tenant: string;
  readonly principal: NonModelPrincipal;
  readonly request: RunReplyRequest;
}

export interface ReplyToRunResult extends OrchestratedRunResult {
  readonly classification: RunReplyClassification;
}

// --- Orchestrator interface ---

export interface DeclineSpecFindingInput {
  readonly runId: string;
  readonly tenant: string;
  readonly feedbackId: string;
  readonly principal: NonModelPrincipal;
  readonly body: string;
}

type ImplementationGateMutationInput = DispatchRunInput & { readonly principal: NonModelPrincipal };
type SaveTestingPassInput = ImplementationGateMutationInput & { readonly request: SaveTestingGuideResultsRequest };
type CreateImplementationFeedbackInput = ImplementationGateMutationInput & { readonly title: string; readonly body: string };

export interface Orchestrator {
  saveTestingGuideResults?(input: SaveTestingPassInput): Promise<TestingGuideResults>;
  createImplementationFeedback?(input: CreateImplementationFeedbackInput): Promise<Feedback>;
  declineSpecFinding?(input: DeclineSpecFindingInput): Promise<Feedback>;
  createRun(input: CreateOrchestratedRunInput): Promise<OrchestratedRunResult>;
  createConversationWithFirstRun(input: CreateOrchestratedConversationInput): Promise<OrchestratedConversationResult>;
  applyDirective(input: ApplyOrchestratedDirectiveInput): Promise<OrchestratedRunResult>;
  cancelRun(input: OperatorTransitionInput): Promise<OrchestratedRunResult>;
  setRunStep(input: OperatorTransitionInput & { step: string }): Promise<OrchestratedRunResult>;
  dispatch(input: DispatchRunInput): Promise<OrchestratedRunResult>;
  tick(input: TickInput): Promise<TickResult>;
  replyToRun(input: ReplyToRunInput): Promise<ReplyToRunResult>;
  workspaceHeld?(input: DispatchRunInput): Promise<boolean>;
  detectMerges(tenant: string, admitCiRepair?: boolean): Promise<PullRequestStatusReconciliationResult>;
  refreshRunPullRequest(input: DispatchRunInput): Promise<RefreshPullRequestOutcome>;
  /** Serialize the repository's failed-only reopen, without admitting the run for dispatch. */
  reopenFailedRun(input: RecoverFailedRunInput, tenant: string): Promise<RecoverFailedRunResult>;
  /**
   * Admit an already-reopened run (e.g. after recovery) for dispatch through the existing
   * queue, per-run serialization, and concurrency controls — without calling the runner
   * directly. A no-op when the run is missing, cross-tenant, terminal, or not AI/system-waiting.
   */
  admitForDispatch(input: DispatchRunInput): Promise<void>;
}

// --- Spec authoring completion ---

export interface WorkspaceContext {
  readonly workspaceRepoRoot: string;
  readonly workspaceHandle: string;
}

export type WorkspaceContextResolver = (input: { runId: string }) => Promise<WorkspaceContext>;

// --- Constructor options ---

export interface AutoDispatchOptions {
  readonly enabled?: boolean;
}

export interface DefaultOrchestratorOptions {
  readonly workflowResolver?: RunWorkflowResolver;
  readonly runs: RunRepository;
  readonly conversationIngress: ConversationIngressRepository;
  readonly events: RunEventStore;
  readonly dispatchQueue: RunDispatchQueue;
  readonly unitOfWork?: RunUnitOfWork;
  readonly clock?: () => string;
  readonly eventIdGenerator?: () => string;
  readonly isActiveRunConflict?: (error: unknown) => boolean;
  readonly logger?: { warn(message: string, details?: unknown): void; info?(message: string, details?: unknown): void };
  readonly specAuthoringDependencies?: SpecAuthoringServiceDependencies;
  readonly resolveWorkspaceContext?: WorkspaceContextResolver;
  readonly runWorkspaceMetadata?: RunWorkspaceMetadataRepository;
  readonly resolveApproverAddressedFeedback?: typeof resolveApproverAddressedFeedback;
  readonly assertSpecReviewGateCanAdvance?: typeof assertSpecReviewGateCanAdvance;
  readonly feedbackLifecycleDependencies?: FeedbackLifecycleDependencies;
  readonly finalizeSpecApproval?: typeof finalizeSpecApproval;
  readonly specApprovalFinalizerDependencies?: SpecApprovalFinalizerDependencies;
  readonly freezeRunSpecForPullRequest?: typeof freezeRunSpecForPullRequest;
  readonly specFreezeDependencies?: SpecFreezeDependencies;
  readonly runSteps?: RunStepRepository;
  readonly testingGuides?: TestingGuideRepository;
  readonly testResults?: TestResultRepository;
  readonly convergenceEngine?: ConvergenceEngine;
  readonly autoDispatch?: AutoDispatchOptions;
  readonly pullRequestOpenDependencies?: PullRequestOpenWiringDependencies;
}

export interface PullRequestOpenWiringDependencies {
  readonly conversations: ConversationRepository;
  readonly topics: TopicRepository;
  readonly projects: ProjectRepository;
  readonly pullRequests: PullRequestRepository;
  readonly codeHosts: CodeHostRegistry;
  readonly resolveCredential: ResolveCodeHostCredential;
  readonly runWorkspaceGit?: Pick<RunWorkspaceGitPort, 'getChangedFiles'>;
  readonly publicationGit?: PublicationGitPort;
  readonly publicationRemoteOverride?: string;
  readonly repair?: { readonly repository: RepairRepository; readonly limit: number };

}

function isWorkflowResolutionFailure(error: unknown): boolean {
  return error instanceof OrchestratorError && error.cause instanceof RunLifecycleError &&
    (error.cause.code === 'unknown_workflow' || error.cause.code === 'unknown_work_kind');
}

function defaultIsActiveRunConflict(error: unknown): boolean {
  return error instanceof Error && error.name === 'ActiveRunConflictPersistenceError';
}

function unwrapCause(error: unknown): unknown {
  if (error instanceof Error && 'cause' in error && error.cause !== undefined) {
    return error.cause;
  }
  return undefined;
}

class TestingGuideAdvanceInterrupted extends Error {
  constructor(cause: unknown) {
    super('Testing guide was stored before the advance was interrupted.', { cause });
  }
}

// --- Implementation ---

function testingPassConflict(error: TestingGuidePassConflictError): OrchestratorError {
  return new OrchestratorError('conflict', error.message, error.latestGuideRevision === undefined ? {} : {
    details: { code: 'stale_guide_revision', latestGuideRevision: error.latestGuideRevision }
  });
}

export class DefaultOrchestrator implements Orchestrator {
  readonly #runs: RunRepository;
  readonly #workflowResolver: RunWorkflowResolver;
  readonly #conversationIngress: ConversationIngressRepository;
  readonly #events: RunEventStore;
  readonly #dispatchQueue: RunDispatchQueue;
  readonly #unitOfWork: RunUnitOfWork | undefined;
  readonly #clock: (() => string) | undefined;
  readonly #eventIdGenerator: (() => string) | undefined;
  readonly #isActiveRunConflict: (error: unknown) => boolean;
  readonly #logger: DefaultOrchestratorOptions['logger'];
  readonly #specAuthoringDependencies: SpecAuthoringServiceDependencies | undefined;
  readonly #resolveWorkspaceContext: WorkspaceContextResolver | undefined;
  readonly #runWorkspaceMetadata: RunWorkspaceMetadataRepository | undefined;
  readonly #resolveApproverAddressedFeedback: typeof resolveApproverAddressedFeedback;
  readonly #assertSpecReviewGateCanAdvance: typeof assertSpecReviewGateCanAdvance;
  readonly #feedbackLifecycleDependencies: FeedbackLifecycleDependencies | undefined;
  readonly #finalizeSpecApproval: typeof finalizeSpecApproval;
  readonly #specApprovalFinalizerDependencies: SpecApprovalFinalizerDependencies | undefined;
  readonly #freezeRunSpecForPullRequest: typeof freezeRunSpecForPullRequest;
  readonly #specFreezeDependencies: SpecFreezeDependencies | undefined;
  readonly #runSteps: RunStepRepository | undefined;
  readonly #testingGuides: TestingGuideRepository | undefined;
  readonly #testResults: TestResultRepository | undefined;
  readonly #convergenceEngine: ConvergenceEngine | undefined;
  readonly #repairEpoch = randomUUID();
  readonly #repairWakeups = new Set<string>();
  readonly #batchCursor = new Map<string, { createdAt: string; id: string }>();
  readonly #pullRequestOpenDependencies: PullRequestOpenWiringDependencies | undefined;
  readonly #autoDispatchEnabled: boolean;
  readonly #dispatchReservations = new Map<string, DispatchReservation>();
  readonly #runMutationTails = new Map<string, Promise<void>>();

  constructor(options: DefaultOrchestratorOptions) {
    this.#runs = options.runs;
    this.#workflowResolver = options.workflowResolver ?? defaultRunWorkflowResolver;
    this.#conversationIngress = options.conversationIngress;
    this.#events = options.events;
    this.#dispatchQueue = options.dispatchQueue;
    this.#unitOfWork = options.unitOfWork;
    this.#autoDispatchEnabled = options.autoDispatch?.enabled !== false;
    this.#clock = options.clock;
    this.#eventIdGenerator = options.eventIdGenerator;
    this.#isActiveRunConflict = options.isActiveRunConflict ?? defaultIsActiveRunConflict;
    this.#logger = options.logger;
    this.#specAuthoringDependencies = options.specAuthoringDependencies;
    this.#resolveWorkspaceContext = options.resolveWorkspaceContext;
    this.#runWorkspaceMetadata = options.runWorkspaceMetadata;
    this.#resolveApproverAddressedFeedback = options.resolveApproverAddressedFeedback ?? resolveApproverAddressedFeedback;
    this.#assertSpecReviewGateCanAdvance = options.assertSpecReviewGateCanAdvance ?? assertSpecReviewGateCanAdvance;
    this.#feedbackLifecycleDependencies = options.feedbackLifecycleDependencies;
    this.#finalizeSpecApproval = options.finalizeSpecApproval ?? finalizeSpecApproval;
    this.#specApprovalFinalizerDependencies = options.specApprovalFinalizerDependencies;
    this.#freezeRunSpecForPullRequest = options.freezeRunSpecForPullRequest ?? freezeRunSpecForPullRequest;
    this.#specFreezeDependencies = options.specFreezeDependencies;
    this.#runSteps = options.runSteps;
    this.#testingGuides = options.testingGuides;
    this.#testResults = options.testResults;
    this.#convergenceEngine = options.convergenceEngine;
    this.#pullRequestOpenDependencies = options.pullRequestOpenDependencies;
  }

  async createRun(input: CreateOrchestratedRunInput): Promise<OrchestratedRunResult> {
    let state: RunLifecycleState;
    try {
      state = await startRunLifecycle({
        runs: this.#runs,
        workflowResolver: this.#workflowResolver,
        run: input,
        ...(this.#clock !== undefined ? { clock: this.#clock } : {})
      });
    } catch (error) {
      if (error instanceof RunLifecycleError && error.code !== 'start_persistence_failed') {
        throw this.#mapLifecycleError(error);
      }
      const conflictSource = this.#isActiveRunConflict(error)
        ? error
        : this.#isActiveRunConflict(unwrapCause(error))
          ? unwrapCause(error)
          : undefined;
      if (conflictSource !== undefined) {
        const existing = await this.#runs.findActiveByTopic(input.topicId).catch(() => null);
        const details: ActiveRunConflictDetails = {
          topicId: input.topicId,
          existingRunId: existing?.id ?? null
        };
        throw new OrchestratorError(
          'active_run_conflict',
          `Active run conflict for topic '${input.topicId}'.`,
          { details, cause: conflictSource }
        );
      }
      if (error instanceof RunLifecycleError) {
        throw this.#mapLifecycleError(error);
      }
      throw new OrchestratorError('persistence_failed', 'Failed to create run.', { cause: error });
    }

    await this.#publishRunStart(state);

    return { run: state.run, runStep: { ...state.runStep, checkpointResult: publicSpecCheckpoint(state.runStep.checkpointResult) } };
  }

  async createConversationWithFirstRun(
    input: CreateOrchestratedConversationInput
  ): Promise<OrchestratedConversationResult> {
    const { workKind, tenant, projectId } = input;
    const workflow = await this.#requireWorkflow({ kind: 'new_conversation', workKind, tenant, projectId });
    const firstStep = workflow.steps[0];
    if (firstStep === undefined) {
      throw new OrchestratorError('persistence_failed', `Workflow '${workflow.id}' has no steps.`);
    }
    const step = getRunStepDefinition(firstStep);
    if (step === null) {
      throw new OrchestratorError('persistence_failed', `Unknown step '${firstStep}'.`);
    }

    const startedAt = this.#clock?.() ?? new Date().toISOString();
    const runStepInput: LifecycleRunStepInput = buildEntryRunStep(step, startedAt);

    let result: CreateConversationTopicMessageAndRunResult;
    try {
      result = await this.#conversationIngress.createConversationTopicMessageAndRun({
        conversation: {
          projectId: input.projectId,
          owner: input.owner,
          tenant: input.tenant,
          identity: input.identity,
          ...(input.channel !== undefined ? { channel: input.channel } : {}),
          activeTopicId: null
        },
        topic: {
          owner: input.owner,
          tenant: input.tenant,
          title: input.topic.title,
          kind: 'main'
        },
        ...(input.message !== undefined
          ? {
              message: {
                owner: input.owner,
                tenant: input.tenant,
                author: input.owner,
                direction: 'inbound' as const,
                body: input.message.body,
                ...(input.message.intent !== undefined ? { intent: input.message.intent } : {})
              }
            }
          : {}),
        run: {
          owner: input.owner,
          tenant: input.tenant,
          workKind: input.workKind,
          currentStep: step.id,
          terminal: deriveRunTerminal(step.id),
          ...(input.trackedIssue !== undefined ? { trackedIssue: input.trackedIssue } : {}),
          ...(input.testingGuideResult !== undefined
            ? { testingGuideResult: input.testingGuideResult }
            : {})
        },
        runStep: runStepInput
      });
    } catch (error) {
      const conflictSource = this.#isActiveRunConflict(error)
        ? error
        : this.#isActiveRunConflict(unwrapCause(error))
          ? unwrapCause(error)
          : undefined;
      if (conflictSource !== undefined) {
        const topicId =
          conflictSource instanceof Error &&
          'topicId' in conflictSource &&
          typeof (conflictSource as { topicId: unknown }).topicId === 'string'
            ? (conflictSource as { topicId: string }).topicId
            : '';
        const existingRunId =
          conflictSource instanceof Error && 'existingRunId' in conflictSource
            ? ((conflictSource as { existingRunId: unknown }).existingRunId as string | null)
            : null;
        const details: ActiveRunConflictDetails = {
          topicId,
          existingRunId
        };
        throw new OrchestratorError('active_run_conflict', `Active run conflict.`, {
          details,
          cause: conflictSource
        });
      }
      throw new OrchestratorError('persistence_failed', 'Failed to create conversation with run.', {
        cause: error
      });
    }

    await this.#publishRunStart(result);

    return result;
  }

  #mutationKey({ tenant, runId }: DispatchRunInput): string {
    return JSON.stringify([tenant, runId]);
  }

  // Serialize local writes and reservations, never enqueue, runner waits or provider reads.
  async #withRunMutation<T>(
    input: DispatchRunInput,
    work: (applyDirective: ApplyLockedDirective, admit: (result: DispatchSource, force?: boolean) => Promise<void>) => Promise<T>
  ): Promise<T> {
    const key = this.#mutationKey(input);
    const previous = this.#runMutationTails.get(key);
    let release!: () => void;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    this.#runMutationTails.set(key, tail);
    await previous;

    let launch: DispatchReservation | undefined;
    const admit = async (result: DispatchSource, force = false) => {
      if ((!force && !this.#autoDispatchEnabled) || result.run.terminal || !this.#shouldAutoDispatch(result.run)) return;
      const occupied = this.#dispatchReservations.get(key);
      if (occupied !== undefined) {
        occupied.continuation = result;
      } else {
        launch = this.#reserveDispatch(result.run, result.runStep, true);
      }
    };
    try {
      return await work(async (directive, source, decision) => {
        const result = await this.#applyDirectiveUnderLock(directive, source, decision);
        // The next dispatch needs its persisted checkpoint, including a private spec answer.
        await admit(result);
        return { ...result, runStep: { ...result.runStep, checkpointResult: publicSpecCheckpoint(result.runStep.checkpointResult) } };
      }, admit);
    } finally {
      if (this.#runMutationTails.get(key) === tail) this.#runMutationTails.delete(key);
      release();
      if (launch !== undefined) this.#launchDispatch(launch);
    }
  }

  async #publishRunStart(result: OrchestratedRunResult): Promise<void> {
    const input = { tenant: result.run.tenant, runId: result.run.id };
    await this.#withRunMutation(input, async (_apply, admit) => {
      await this.#publishEvent({ ...input, ...result, directive: 'start', toStep: result.run.currentStep });
      if (this.#autoDispatchEnabled && !result.run.terminal && this.#shouldAutoDispatch(result.run) &&
        await this.#dispatchSourceMatches(result)) await admit(result);
    });
  }

  async #requireOperatorRun(input: DispatchRunInput): Promise<Run> {
    const run = await this.#runs.findById(input.runId);
    if (run === null || run.tenant !== input.tenant) throw new OrchestratorError('missing_run', 'Run not found.');
    if (run.terminal) {
      const reason = run.currentStep === 'failed'
        ? `Run is failed; use POST /v1/runs/${run.id}/recover.`
        : `Run is terminal (${run.currentStep}).`;
      throw new OrchestratorError('terminal_run', reason, { details: { reason } });
    }
    return run;
  }

  cancelRun(input: OperatorTransitionInput): Promise<OrchestratedRunResult> {
    return this.#withRunMutation(input, async (applyDirective) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const run = await this.#requireOperatorRun(input);
        try {
          return await applyDirective({ ...input, directive: 'cancel', origin: 'human' }, { run, runStep: null });
        } catch (error) {
          const conflict = this.#transitionConflict(error);
          if (conflict === 'terminal_run') {
            await this.#requireOperatorRun(input);
            const reason = 'Run became terminal before cancellation.';
            throw new OrchestratorError('conflict', reason, { details: { reason } });
          }
          if (conflict !== 'source_step_mismatch') throw error;
        }
      }
      const reason = 'Run kept moving; refresh and retry cancellation.';
      throw new OrchestratorError('conflict', reason, { details: { reason } });
    });
  }

  setRunStep(input: OperatorTransitionInput & { step: string }): Promise<OrchestratedRunResult> {
    return this.#withRunMutation(input, async (_apply, admit) => {
      const run = await this.#requireOperatorRun(input);
      const workflow = await this.#requireWorkflow({ kind: 'existing_run', run }).catch((error: unknown) => {
        this.#logger?.warn('Stored run workflow could not be resolved.', { runId: run.id, step: run.currentStep });
        throw error;
      });
      const source = getRunStepDefinition(run.currentStep);
      const isPause = source?.kind === 'pause';
      const positionId = isPause ? workflow.transitions[source.id]?.advance : source?.id;
      const position = positionId === undefined ? null : getRunStepDefinition(positionId);
      const sourceIndex = position === null ? -1 : workflow.steps.indexOf(position.id);
      if (sourceIndex < 0 || position?.kind === 'terminal' || position?.kind === 'pause') {
        this.#logger?.warn('Stored run has no usable workflow position.', { runId: run.id, step: run.currentStep });
        throw new OrchestratorError('persistence_failed', 'Stored run has no usable workflow position.');
      }

      const reject = (reason: string): never => {
        throw new OrchestratorError('invalid_transition', reason, { details: { reason } });
      };
      const target = getRunStepDefinition(input.step) ?? reject('Unknown target step.');
      if (target.kind === 'terminal') reject('Target is terminal.');
      if (!workflowOwnedSteps(workflow).has(target.id)) reject('Target is not part of the run workflow.');
      if (target.kind === 'pause') reject('Target is an input pause.');
      if (target.phase === null) reject('Target has no phase.');
      if (target.id === run.currentStep) reject('Target is the current step.');
      const targetIndex = workflow.steps.indexOf(target.id);
      if (targetIndex < 0) reject('Target has no position in workflow.steps');
      if (this.#runSteps === undefined) throw new OrchestratorError('persistence_failed', 'Run history is not configured.');
      const history = await this.#runSteps.listByRun(run.id);
      if (!history.some((step) => step.step === target.id)) reject('Run has not reached the target step.');
      if (targetIndex >= sourceIndex) reject('Target is not strictly earlier than the current workflow position.');
      const repairs = await this.#pullRequestOpenDependencies?.repair?.repository.listByRun(run.id, run.tenant) ?? [];
      if (findCurrentRepair(repairs) !== undefined || repairs.some(row => row.workspaceHold) ||
          this.#dispatchReservations.has(this.#mutationKey(input)) || this.#dispatchQueue.hasWorkForRun(run.id)) {
        const reason = 'Run is busy with dispatch work; try again after it settles.';
        throw new OrchestratorError('conflict', reason, { details: { reason } });
      }

      const open = await this.#openRunStep(run);
      if (open === null) {
        const reason = 'Current step occurrence is no longer open.';
        throw new OrchestratorError('conflict', reason, { details: { reason } });
      }
      let result: OrchestratedRunResult;
      try {
        result = await this.#runs.recordRunStepTransition({
          runId: run.id, expectedStep: run.currentStep, currentStep: target.id, terminal: false,
          sourceRunStepId: open.id, abandonInput: isPause,
          runStep: buildEntryRunStep(target, this.#clock?.() ?? new Date().toISOString())
        });
      } catch (error) {
        if (!(error instanceof RunTransitionConflictError)) throw error;
        const reason = 'Run changed before the step move could commit.';
        throw new OrchestratorError('conflict', reason, { details: { reason }, cause: error });
      }
      await this.#publishEvent({
        ...result, runId: run.id, tenant: run.tenant, directive: 'set_step', fromStep: run.currentStep, toStep: target.id
      });
      await admit(result, true);
      return result;
    });
  }

  #transitionConflict(error: unknown): RunTransitionConflictError['code'] | undefined {
    const cause = error instanceof OrchestratorError && error.cause instanceof RunLifecycleError ? error.cause.cause : undefined;
    return cause instanceof RunTransitionConflictError ? cause.code : undefined;
  }

  applyDirective(input: ApplyOrchestratedDirectiveInput): Promise<OrchestratedRunResult> {
    return this.#withRunMutation(input, (applyDirective) => applyDirective(input));
  }

  reopenFailedRun(input: RecoverFailedRunInput, tenant: string): Promise<RecoverFailedRunResult> {
    return this.#withRunMutation({ runId: input.runId, tenant }, async () => {
      if (this.#runs.recoverFailedRun === undefined) {
        throw new OrchestratorError('persistence_failed', 'Run repository does not support recovery.');
      }
      const run = await this.#runs.findById(input.runId);
      if (run === null || run.tenant !== tenant) {
        throw new OrchestratorError('missing_run', 'Run not found.');
      }
      if (run.archivedAt !== undefined && run.currentStep === 'failed') throw new ArchivedRunRecoveryError();
      return this.#runs.recoverFailedRun(input);
    });
  }

  #signalCommittedCancellation(input: DispatchRunInput): void {
    try {
      this.#dispatchReservations.get(this.#mutationKey(input))?.controller?.abort();
    } catch {
      this.#logger?.warn('Dispatch cancellation request failed.', {
        event: 'dispatch_abort_request_failed', runId: input.runId, code: 'abort_request_failed'
      });
    }
  }

  async #applyDirectiveUnderLock(
    input: ApplyOrchestratedDirectiveInput, source?: DispatchSource, decision?: TestingGuidePassDecision
  ): Promise<OrchestratedRunResult> {
    const existing = source?.run ?? await this.#runs.findById(input.runId);
    if (existing === null) {
      throw new OrchestratorError('missing_run', `Run '${input.runId}' does not exist.`);
    }
    if (existing.tenant !== input.tenant) {
      throw new OrchestratorError('forbidden', `Run '${input.runId}' does not belong to tenant '${input.tenant}'.`);
    }
    if (existing.terminal) {
      throw new OrchestratorError('terminal_run', `Run '${input.runId}' is terminal.`);
    }
    const fromStep = existing.currentStep;
    const repairRepository = this.#pullRequestOpenDependencies?.repair?.repository;
    if (repairRepository !== undefined && (fromStep === 'implementation.build' || fromStep === 'implementation.awaiting_input' ||
        fromStep === 'pr.finalize' || fromStep === 'pr.human_review')) {
      const repairs = await repairRepository.listByRun(input.runId, input.tenant);
      const repair = findCurrentRepair(repairs);
      if (repair !== undefined) {
        if (input.directive !== 'cancel') throw new OrchestratorError('invalid_transition', 'The repair owns the current occurrence.');
        const moved = await this.#moveRepair({
          from: repair, state: 'superseded', nextStep: 'canceled', now: this.#repairClock(), stopCode: 'repair_canceled',
          ...(repair.ownerEpoch !== null ? { hold: true } : {})
        });
        if (moved?.transition === undefined) throw new OrchestratorError('invalid_transition', 'The repair occurrence changed.');
        return moved.transition;
      }
      if (repairs.some(row => row.workspaceHold) && fromStep !== 'pr.human_review') {
        throw new OrchestratorError('invalid_transition', 'The run workspace is held for host inspection.');
      }
    }

    if (input.expectedStepId !== undefined &&
        (await this.#runs.findLatestOpenRunStep?.({ runId: input.runId, step: fromStep }))?.id !== input.expectedStepId) {
      throw new OrchestratorError('invalid_transition', 'The run step occurrence changed.');
    }
    if ((input.refreshPublication || input.publicationProvenance !== undefined) && input.origin !== 'system') {
      throw new OrchestratorError('invalid_transition', 'Only the host can authorize a publication transition.');
    }
    const normalizedFailureReason = input.directive === 'fail'
      ? normalizeFailureReasonForPublicSurface(input.reason)
      : undefined;

    const origin = input.origin ?? 'runner';
    const checkpoint = input.checkpointResult;
    if (origin === 'system' && (fromStep === 'pr.finalize' || fromStep === 'pr.open') &&
        checkpoint !== null && typeof checkpoint === 'object' && !Array.isArray(checkpoint) &&
        'kind' in checkpoint && checkpoint.kind === 'publication_stop' && 'code' in checkpoint) {
      this.#logger?.warn('PR publication stopped or invalidated.', {
        event: checkpoint.code, runId: input.runId, step: fromStep,
        refreshCount: 'refreshCount' in checkpoint ? checkpoint.refreshCount : undefined
      });
    }

    // Defense-in-depth: block any advance directive from runner origin when run is at a human gate.
    // Both spec.human_review and implementation.human_review are caught by this guard via
    // waitingOn === 'human'. Only a human-origin directive (from replyToRun) may advance them.
    if (origin === 'runner' && input.directive === 'advance') {
      const currentStepDef = getRunStepDefinition(existing.currentStep);
      if (currentStepDef !== null && currentStepDef.waitingOn === 'human') {
        throw new OrchestratorError(
          'invalid_transition',
          `Step '${existing.currentStep}' is waiting on human input and cannot be advanced by a runner.`
        );
      }
    }

    // Gate guard and approval finalizer for spec.human_review.
    if (input.directive === 'advance' && existing.currentStep === 'spec.human_review') {
      const isSpecWorkflow = existing.workKind === 'feature' || existing.workKind === 'enhancement';

      // For feature/enhancement, required deps must be configured — fail explicitly rather than silently skipping.
      if (isSpecWorkflow) {
        if (this.#feedbackLifecycleDependencies === undefined) {
          throw new OrchestratorError('persistence_failed', 'Feedback lifecycle dependencies required for spec workflows.');
        }
        if (this.#specApprovalFinalizerDependencies === undefined || this.#resolveWorkspaceContext === undefined) {
          throw new OrchestratorError('persistence_failed', 'Spec approval finalizer dependencies required for spec workflows.');
        }
      }

      const approver: NonModelPrincipal = input.principal ?? existing.owner;

      // Co-resolve the approver's own addressed feedback before the gate check.
      if (this.#feedbackLifecycleDependencies !== undefined) {
        await this.#resolveApproverAddressedFeedback(
          { runId: input.runId, target: 'artifact', approver },
          this.#feedbackLifecycleDependencies
        );
      }

      // Gate check: refuse advance while any artifact feedback remains open or addressed.
      try {
        await this.#assertSpecReviewGateCanAdvance(
          { run: existing },
          {
            listBlockingFeedback: this.#feedbackLifecycleDependencies !== undefined
              ? (listInput) => listBlockingFeedback(listInput, this.#feedbackLifecycleDependencies!)
              : async () => []
          }
        );
      } catch (error) {
        if (error instanceof SpecReviewGateBlockedError && error.code === 'feedback_gate_blocked') {
          throw new OrchestratorError('invalid_transition', 'Artifact feedback blocks spec approval.', {
            cause: error,
            details: { code: 'feedback_gate_blocked', blockingFeedbackIds: error.blockingFeedbackIds }
          });
        }
        throw error;
      }

      // Approval finalizer: update spec frontmatter and artifact cached status before advancing.
      if (this.#specApprovalFinalizerDependencies !== undefined && this.#resolveWorkspaceContext !== undefined) {
        let workspaceContext: WorkspaceContext;
        try {
          workspaceContext = await this.#resolveWorkspaceContext({ runId: input.runId });
        } catch (cause) {
          this.#logger?.warn('Failed to resolve workspace context for spec approval finalization.', { runId: input.runId, ...this.#safeCause(cause) });
          throw new OrchestratorError('persistence_failed', 'Failed to resolve workspace context for spec approval.', { cause });
        }
        try {
          await this.#finalizeSpecApproval(
            {
              run: existing,
              approver,
              workspaceRepoRoot: workspaceContext.workspaceRepoRoot,
              workspaceHandle: workspaceContext.workspaceHandle
            },
            this.#specApprovalFinalizerDependencies
          );
        } catch (cause) {
          this.#logger?.warn('Spec approval finalization failed.', { runId: input.runId, ...this.#safeCause(cause) });
          throw new OrchestratorError('persistence_failed', 'Failed to finalize spec approval.', { cause });
        }
      }
    }

    let state: RunLifecycleState;
    try {
      state = await applyRunDirective({
        runs: this.#runs,
        workflowResolver: this.#workflowResolver,
        runId: input.runId,
        directive: input.directive,
        source: existing,
        ...(input.expectedStepId !== undefined ? { sourceRunStepId: input.expectedStepId }
          : source?.runStep == null ? {} : { sourceRunStepId: source.runStep.id }),
        ...(decision === undefined ? {} : { testingGuideDecision: decision }),
        ...(input.refreshPublication ? { refreshPublication: true } : {}),
        ...(input.publicationProvenance !== undefined ? { publicationProvenance: input.publicationProvenance } : {}),
        ...(input.checkpointResult !== undefined ? { checkpointResult: input.checkpointResult } : {}),
        ...(input.destinationCheckpointResult !== undefined ? { destinationCheckpointResult: input.destinationCheckpointResult } : {}),
        ...(normalizedFailureReason !== undefined ? { reason: normalizedFailureReason } : {}),
        ...(this.#clock !== undefined ? { clock: this.#clock } : {})
      });
    } catch (error) {
      if (error instanceof RunLifecycleError && decision !== undefined) {
        if (error.cause instanceof TestingGuidePassConflictError) throw testingPassConflict(error.cause);
        if (error.code === 'source_occurrence_mismatch' || error.code === 'source_step_mismatch') {
          throw testingPassConflict(new TestingGuidePassConflictError());
        }
      }
      if (error instanceof RunLifecycleError) {
        throw this.#mapLifecycleError(error);
      }
      throw new OrchestratorError('persistence_failed', 'Failed to apply directive.', {
        cause: error
      });
    }

    if (input.directive === 'cancel' && state.run.currentStep === 'canceled') this.#signalCommittedCancellation(input);
    await this.#publishEvent({
      runId: state.run.id,
      directive: input.directive as RunStateTransitionKind,
      fromStep,
      toStep: state.run.currentStep,
      run: state.run,
      runStep: state.runStep,
      tenant: state.run.tenant,
      ...(normalizedFailureReason !== undefined ? { reason: normalizedFailureReason } : {})
    });

    return { run: state.run, runStep: state.runStep };
  }

  async #openRunStep(run: Run): Promise<RunStep | null> {
    if (this.#runs.findLatestOpenRunStep !== undefined) {
      return this.#runs.findLatestOpenRunStep({ runId: run.id, step: run.currentStep });
    }
    const steps = await this.#runSteps?.listByRun(run.id) ?? [];
    return [...steps].reverse().find((step) => step.step === run.currentStep && step.endedAt === null) ?? null;
  }

  #reserveDispatch(run: Run, runStep: RunStep | null, automatic: boolean): DispatchReservation {
    let resolve!: DispatchReservation['resolve'];
    let reject!: DispatchReservation['reject'];
    const result = new Promise<OrchestratedRunResult>((ok, fail) => { resolve = ok; reject = fail; });
    const reservation = { run, runStep, automatic, result, resolve, reject };
    this.#dispatchReservations.set(this.#mutationKey({ runId: run.id, tenant: run.tenant }), reservation);
    // Auto-dispatch is detached; explicit callers still receive the result/rejection.
    void result.catch(() => undefined);
    return reservation;
  }

  async #dispatchSourceMatches(source: DispatchSource): Promise<boolean> {
    const run = await this.#runs.findById(source.run.id);
    if (run === null || run.tenant !== source.run.tenant || run.terminal || run.currentStep !== source.run.currentStep) return false;
    const hasOpenStepLookup = this.#runs.findLatestOpenRunStep !== undefined;
    // Legacy test doubles may not have a step store. In production an open
    // occurrence must exist, and merely returning to the same name is stale.
    if (!hasOpenStepLookup && this.#runSteps === undefined) return true;
    if (hasOpenStepLookup && source.runStep === null) return false;
    return ((await this.#openRunStep(run))?.id ?? null) === (source.runStep?.id ?? null);
  }

  #launchDispatch(reservation: DispatchReservation): void {
    const { run } = reservation;
    const input = { runId: run.id, tenant: run.tenant };
    let discarded = false;
    const discard = () => {
      if (discarded) return;
      discarded = true;
      this.#logger?.info?.('dispatch_result_discarded', { runId: run.id, step: run.currentStep });
    };
    const commit: CommitDispatchResult = (work) => this.#withRunMutation(input, async () => {
      if (discarded || !await this.#dispatchSourceMatches(reservation)) {
        discard();
        return undefined;
      }
      return work();
    });
    const commitTransition: CommitDispatchTransition = (work) => this.#withRunMutation(input, async (applyLocked) => {
      if (discarded || !await this.#dispatchSourceMatches(reservation)) {
        discard();
        throw new StaleDispatchError();
      }
      return work((directive) => applyLocked(directive, reservation));
    });
    const apply: Orchestrator['applyDirective'] = (directive) => commitTransition((applyLocked) => applyLocked(directive));

    const perform = async () => {
      let result: OrchestratedRunResult | undefined;
      let failure: unknown;
      try {
        result = await this.#dispatchQueue.enqueueForRun(run.id, async () => {
          const controller = await this.#withRunMutation(input, async () => {
            if (!await this.#dispatchSourceMatches(reservation)) throw new StaleDispatchError();
            return reservation.controller = new AbortController();
          });
          try {
            return await this.#dispatchReserved(input, reservation, apply, commit, commitTransition, controller.signal);
          } finally {
            if (reservation.controller === controller) delete reservation.controller;
          }
        });
      } catch (error) {
        const conflict = this.#transitionConflict(error);
        if (error instanceof StaleDispatchError || conflict !== undefined || !await this.#dispatchSourceMatches(reservation)) {
          discard();
          const current = await this.#runs.findById(run.id);
          const step = current === null ? null : await this.#openRunStep(current);
          if (current !== null && step !== null) {
            result = { run: current, runStep: { ...step, checkpointResult: publicSpecCheckpoint(step.checkpointResult) } };
          } else failure = new OrchestratorError('conflict', 'Dispatch source changed.');
        } else {
          failure = error;
          if (error instanceof TestingGuideAdvanceInterrupted) {
            this.#logger?.warn('testing_guide_advance_interrupted', {
              runId: run.id, step: run.currentStep, runStepId: reservation.runStep?.id,
              ...this.#safeCause(error.cause)
            });
          } else if (reservation.automatic) await this.#handleAutoDispatchFailure(run, error, apply);
        }
      } finally {
        await this.#withRunMutation(input, async (_apply, admit) => {
          if (this.#dispatchReservations.get(this.#mutationKey(input)) !== reservation) return;
          this.#dispatchReservations.delete(this.#mutationKey(input));
          const next = reservation.continuation;
          if (next !== undefined && await this.#dispatchSourceMatches(next)) await admit(next);
        });
      }
      if (result !== undefined) reservation.resolve(result);
      else reservation.reject(failure);
    };
    void perform().catch(reservation.reject);
  }

  async dispatch(input: DispatchRunInput): Promise<OrchestratedRunResult> {
    let launch: DispatchReservation | undefined;
    const reservation = await this.#withRunMutation(input, async () => {
      const run = await this.#runs.findById(input.runId);
      if (run === null) throw new OrchestratorError('missing_run', `Run '${input.runId}' does not exist.`);
      if (run.tenant !== input.tenant) throw new OrchestratorError('forbidden', 'Run is not accessible.');
      if (run.terminal) throw new OrchestratorError('terminal_run', `Run '${run.id}' is terminal.`);
      const occupied = this.#dispatchReservations.get(this.#mutationKey(input));
      if (occupied !== undefined) return occupied;
      launch = this.#reserveDispatch(run, await this.#openRunStep(run), false);
      return launch;
    });
    if (launch !== undefined) this.#launchDispatch(launch);
    return reservation.result;
  }

  async #dispatchReserved(
    input: DispatchRunInput,
    source: DispatchSource,
    apply: Orchestrator['applyDirective'],
    commit: CommitDispatchResult,
    commitTransition: CommitDispatchTransition,
    signal: AbortSignal
  ): Promise<OrchestratedRunResult> {
    const { run } = source;
    const repairs = await this.#pullRequestOpenDependencies?.repair?.repository.listByRun(run.id, run.tenant) ?? [];
    if (repairs.some(row => row.workspaceHold)) {
      throw new OrchestratorError('invalid_transition', 'The run workspace is held for host inspection.');
    }
    const repair = findCurrentRepair(repairs);
    if (repair !== undefined) {
      const step = source.runStep;
      if (repair.state !== 'queued' || step === null || step.id !== repair.currentStepId || step.endedAt !== null) {
        throw new OrchestratorError('invalid_transition', 'The repair occurrence is no longer queued.');
      }
      const result = await executeRepair({ run, runStep: step }, repair, this.#repairWorker(signal));
      if (signal.aborted) throw new StaleDispatchError();
      return result;
    }

    const stepDefinition = getRunStepDefinition(run.currentStep);
    if (stepDefinition?.waitingOn === 'human') {
      throw new OrchestratorError(
        'invalid_transition',
        `Step '${run.currentStep}' is waiting on human input and cannot be dispatched to a runner.`
      );
    }

    if (stepDefinition?.waitingOn === 'system') {
      return this.#dispatchSystemStep(input, source, apply, commitTransition);
    }

    // implementation.plan deterministic passthrough: records an explicit checkpoint and advances
    // to implementation.build without dispatching an AI prompt. Planning is intentionally a no-op
    // for issue 63; a real plan step is tracked for a future issue.
    if (run.currentStep === 'implementation.plan') {
      return apply({
        runId: input.runId,
        tenant: input.tenant,
        directive: 'advance',
        origin: 'system',
        checkpointResult: {
          kind: 'implementation_plan_passthrough',
          reason: 'issue_63_reply_ingress_uses_existing_build_convergence'
        }
      });
    }

    const workflow = stepDefinition?.id === 'spec.author' && stepDefinition.roles.includes('reviewer') &&
        stepDefinition.roles.includes('implementer')
      ? await this.#requireWorkflow({ kind: 'existing_run', run })
      : undefined;
    if (stepDefinition !== null && (workflow?.artifactKind === 'feature_spec' || workflow?.artifactKind === 'enhancement_spec')) {
      const steps = await this.#runSteps?.listByRun(run.id) ?? [];
      const runStep = source.runStep;
      const fail = (reason: string) => apply({
        runId: run.id, tenant: run.tenant, directive: 'fail', origin: 'runner', reason
      });
      const engine = this.#convergenceEngine;
      const deps = this.#specAuthoringDependencies;
      const resolveWorkspace = this.#resolveWorkspaceContext;
      if (!engine?.runSpec || !runStep || !deps?.git.readHeadFile || !resolveWorkspace) {
        return fail('spec_review_not_configured');
      }
      const readHeadFile = deps.git.readHeadFile;
      const readHead = async (path: string) => {
        const workspace = await resolveWorkspace({ runId: run.id });
        return readHeadFile({ workspaceRepoRoot: workspace.workspaceRepoRoot, relativePath: path });
      };
      const marker = runStep.checkpointResult as { specAnswer?: { sourceStepId: string; role: 'implementer' | 'reviewer'; body: string } } | null;
      const workspace = await resolveWorkspace({ runId: run.id }).catch(() => undefined);
      try {
        const result = await engine.runSpec({
          run, runId: run.id, tenant: run.tenant, runStep, stepDefinition, workflow, steps, readHead, commitResult: commit, signal,
          stillOwns: () => this.#dispatchSourceMatches(source),
          ...(workspace ? { workspace } : {}),
          ...(marker?.specAnswer ? { answer: marker.specAnswer } : {}),
          readCanonicalSpec: async () => {
            const artifact = await deps.artifacts.findByRunAndKind({ runId: run.id, kind: workflow.artifactKind! });
            if (!artifact) return undefined;
            if (artifact.tenant !== run.tenant || artifact.runId !== run.id) throw new Error('Invalid spec artifact.');
            const markdown = await readHead(artifact.location);
            if (markdown === null) throw new Error('Spec artifact has no committed Markdown.');
            return { path: artifact.location, markdown };
          },
          complete: async (spec, markdown) => {
            const context = await resolveWorkspace({ runId: run.id });
            const result = await commit(() => this.#runSpecAuthoringCompletion(run.id, run, spec, markdown, context));
            if (result === undefined) throw new StaleDispatchError();
            return result.kind === 'ok' ? result.output : undefined;
          }
        });
        if (result.directive === 'cancelled' || signal.aborted) throw new StaleDispatchError();
        if (result.directive === 'fail') return fail(result.reason);
        return apply({
          runId: run.id, tenant: run.tenant, directive: result.directive, origin: 'runner',
          checkpointResult: result.checkpoint,
          ...(result.directive === 'needs_input' ? { destinationCheckpointResult: { pause: result.pause } } : {})
        });
      } catch (cause) {
        if (cause instanceof StaleDispatchError || this.#transitionConflict(cause) || !await this.#dispatchSourceMatches(source)) throw cause;
        this.#logger?.warn('Spec convergence failed.', { runId: run.id, ...this.#safeCause(cause) });
        return fail(safeFailureReasonFromError(cause) ?? 'spec_authoring_failed');
      }
    }

    if (stepDefinition !== null && this.#isReviewedProducingStep(stepDefinition) && this.#convergenceEngine !== undefined) {
      const convergenceEngine = this.#convergenceEngine;
      const workflow = await this.#requireWorkflow({ kind: 'existing_run', run });
      const runSteps = this.#runSteps !== undefined ? await this.#runSteps.listByRun(input.runId) : [];
      const runStep = source.runStep ?? {
        id: `${input.runId}_step`,
        runId: input.runId,
        phase: stepDefinition.phase,
        step: stepDefinition.id,
        role: 'none' as const,
        startedAt: this.#clock?.() ?? new Date().toISOString(),
        endedAt: null,
        durationMs: null,
        occurrence: { index: 0, attempt: 1 },
        checkpointResult: null
      };
      // Read guidance from the current build step checkpoint (stamped during guidance reply).
      // If the checkpoint carries resumedFromAwaitingInputStepId, follow the reference to load
      // the guidance from that specific pause step rather than searching all history.
      const humanGuidance: string | undefined = (() => {
        const buildCp = runStep.checkpointResult as {
          humanGuidance?: string;
          resumedFromAwaitingInputStepId?: string;
        } | null;
        if (buildCp === null || typeof buildCp !== 'object') return undefined;
        if (typeof buildCp.humanGuidance === 'string') return buildCp.humanGuidance;
        if (typeof buildCp.resumedFromAwaitingInputStepId === 'string') {
          const pauseStepId = buildCp.resumedFromAwaitingInputStepId;
          const pauseStep = runSteps.find(s => s.id === pauseStepId);
          if (pauseStep !== undefined) {
            const cp = pauseStep.checkpointResult as { pause?: { kind?: string; humanGuidance?: string } } | null;
            if (cp?.pause?.kind === 'convergence_escalation' && typeof cp.pause.humanGuidance === 'string') {
              return cp.pause.humanGuidance;
            }
          }
        }
        return undefined;
      })();
      const resolvedWorkspace = this.#resolveWorkspaceContext !== undefined
        ? await this.#resolveWorkspaceContext({ runId: input.runId }).catch(() => undefined)
        : undefined;
      const result = await convergenceEngine.run({
        runId: input.runId,
        run,
        tenant: input.tenant,
        runStep,
        stepDefinition,
        workflow,
        commitResult: commit,
        signal,
        stillOwns: () => this.#dispatchSourceMatches(source),
        ...(() => {
          for (const prior of [...runSteps].reverse()) {
            if (prior.id === runStep.id || prior.step !== 'implementation.build') continue;
            const parsed = convergenceCheckpointSchema.safeParse(prior.checkpointResult);
            if (parsed.success) return { priorCheckpoint: parsed.data };
          }
          return {};
        })(),
        ...(resolvedWorkspace !== undefined ? { workspace: resolvedWorkspace } : {}),
        ...(humanGuidance !== undefined ? { humanGuidance } : {})
      });

      if (result.cancelled || signal.aborted) throw new StaleDispatchError();
      if (result.workResult.directive === 'fail') {
        const reason = result.workResult.reason;
        return apply({ runId: input.runId, directive: 'fail', tenant: input.tenant, reason, origin: 'runner' });
      }
      if (result.workResult.directive === 'needs_input') {
        const pause = buildConvergenceEscalationPause(result.checkpointResult);
        return apply({
          runId: input.runId,
          directive: 'needs_input',
          tenant: input.tenant,
          checkpointResult: result.checkpointResult as unknown as JsonValue,
          ...(pause !== null ? { destinationCheckpointResult: pause } : {}),
          origin: 'runner'
        });
      }
      const convergenceClock = this.#clock ?? (() => new Date().toISOString());
      let enrichedCheckpoint: unknown = result.checkpointResult;
      if (result.checkpointResult.rounds.length > 0) {
        try {
          const cumulativeSummary = buildCumulativeImplementationSummary({
            rounds: buildImplementationSummaryRoundInputs(result.checkpointResult.rounds),
            completedAt: convergenceClock()
          });
          enrichedCheckpoint = { ...result.checkpointResult, cumulativeSummary };
        } catch {
          // Non-fatal: pr-open-handler will surface a clear error if summary is missing
        }
      }
      return apply({
        runId: input.runId,
        directive: 'advance',
        tenant: input.tenant,
        checkpointResult: enrichedCheckpoint as unknown as JsonValue,
        origin: 'runner'
      });
    }

    if (run.currentStep === 'implementation.testing_guide') {
      return this.#dispatchTestingGuide(source, commitTransition, signal);
    }

    if (this.#unitOfWork === undefined) {
      throw new OrchestratorError('persistence_failed', 'No unit of work configured.');
    }
    const unitOfWork = this.#unitOfWork;

    const prDeps = this.#pullRequestOpenDependencies;
    const publication = run.currentStep === 'pr.finalize' ? prDeps?.publicationGit : undefined;
    let integrated: { workspace: Awaited<ReturnType<typeof resolvePublicationBinding>>['workspace']; sourceSha: string; targetSha: string; headSha: string } | undefined;
    let finalizationStepId: string | undefined;
    let epoch = { count: 0, sourcePushed: false };
    const publicationStop = (code: string, details: Record<string, JsonValue> = {}) => apply({
      runId: run.id, tenant: run.tenant, origin: 'system', directive: 'fail', reason: code,
      ...(finalizationStepId !== undefined ? { expectedStepId: finalizationStepId } : {}),
      checkpointResult: {
        kind: 'publication_stop', code, base: initialPullRequestBase,
        timestamp: (this.#clock ?? (() => new Date().toISOString()))(),
        refreshCount: epoch.count, sourcePushed: epoch.sourcePushed, ...details
      }
    });
    if (publication !== undefined && prDeps !== undefined && this.#runWorkspaceMetadata !== undefined) {
      const current = source.runStep;
      if (current == null) throw new OrchestratorError('invalid_transition', 'Finalization occurrence changed.');
      finalizationStepId = current.id;
      if (this.#runSteps === undefined) throw new OrchestratorError('persistence_failed', 'Finalization requires run history.');
      epoch = publicationEpoch(await this.#runSteps.listByRun(run.id));
      let binding;
      try {
        binding = await resolvePublicationBinding(run, { ...prDeps, runWorkspaceMetadata: this.#runWorkspaceMetadata });
      } catch {
        return publicationStop('pr_target_verification_failed', { safeReason: 'binding_unavailable' });
      }
      const { workspace } = binding;
      const evidence = { branch: workspace.branch, repository: workspace.repository };
      const integration = await publication.integrate(workspace);
      switch (integration.kind) {
        case 'target_unverified':
          return publicationStop('pr_target_verification_failed', { ...evidence, safeReason: 'target_unavailable', sourceSha: integration.sourceSha ?? null });
        case 'workspace_unavailable':
          return publicationStop('pr_integration_workspace_unavailable', { ...evidence, safeReason: 'workspace_not_ready' });
        case 'conflict':
          return publicationStop('pr_integration_conflict', {
            ...evidence, sourceSha: integration.sourceSha, targetSha: integration.targetSha,
            paths: [...integration.paths], cleanup: integration.cleanup
          });
        case 'integrated':
          integrated = { workspace, ...integration };
      }
      if (!await this.#dispatchSourceMatches(source)) throw new StaleDispatchError();
    }
    const treeSha = integrated && publication?.readTree
      ? await publication.readTree(integrated.workspace, integrated.headSha) : undefined;
    if (treeSha === null) return publicationStop('pr_integration_workspace_unavailable', { safeReason: 'tree_unavailable' });
    const baseWorkInput: RunWorkInput = { runId: input.runId, run, tenant: input.tenant, signal,
      ...(integrated && finalizationStepId ? { publicationReview: {
        occurrenceId: finalizationStepId, candidateSha: integrated.headSha, targetSha: integrated.targetSha,
        ...(treeSha ? { treeSha } : {})
      } } : {})
    };
    const workInput: RunWorkInput = run.currentStep === 'pr.finalize'
      ? { ...baseWorkInput, toolPolicyMode: 'read_only' }
      : baseWorkInput;
    if (signal.aborted) throw new StaleDispatchError();
    const result = await unitOfWork.run(workInput);
    if (result.directive === 'cancelled' || signal.aborted || !await this.#dispatchSourceMatches(source)) throw new StaleDispatchError();
    const finalized = result.directive === 'advance' && run.currentStep === 'pr.finalize'
      ? await validatePullRequestFinalizeResult({ runId: input.runId, rawResult: result.result })
      : undefined;
    let workspaceForFreeze: WorkspaceContext | undefined;
    let workspaceError: unknown;
    if (finalized?.status === 'valid' && finalized.value.directive === 'advance' &&
      (run.workKind === 'feature' || run.workKind === 'enhancement') &&
      this.#specFreezeDependencies !== undefined && this.#resolveWorkspaceContext !== undefined) {
      try { workspaceForFreeze = await this.#resolveWorkspaceContext({ runId: input.runId }); }
      catch (error) { workspaceError = error; }
    }
    return commitTransition(async (apply) => {
      if (result.directive === 'fail') {
        return apply({ runId: input.runId, directive: 'fail', tenant: input.tenant, reason: result.reason, origin: 'runner' });
      }
      if (result.directive === 'needs_input') {
        const workflow = await this.#requireWorkflow({ kind: 'existing_run', run });
        if (stepDefinition === null || workflow.transitions[stepDefinition.id]?.needs_input === undefined) {
          throw new OrchestratorError(
            'invalid_transition',
            `Step '${run.currentStep}' in workflow '${run.workKind}' has no 'needs_input' edge.`
          );
        }
      }

      // For pr.finalize advance: validate through the tolerance pipeline (normalizes {} to clean advance,
      // then validates). A `revise` directive routes back to implementation.human_review and records
      // Feedback for any blockers/warnings. An `advance` directive stores a sanitized checkpoint and
      // advances toward pr.open. T-009 will insert a deterministic spec freeze before the advance is applied.
      if (finalized !== undefined) {
        if (finalized.status === 'failed') {
          this.#logger?.warn('pr.finalize result failed validation.', { runId: input.runId, reason: finalized.reason });
          return apply({
            runId: input.runId,
            directive: 'fail',
            tenant: input.tenant,
            reason: finalized.reason,
            origin: 'runner'
          });
        }
        const parsed = finalized.value;
        const invalidateCandidate = () => apply({
          runId: run.id, tenant: run.tenant, origin: 'system', directive: 'advance',
          ...(finalizationStepId !== undefined ? { expectedStepId: finalizationStepId } : {}),
          checkpointResult: { kind: 'publication_candidate_invalidated' }
        });
        if (integrated && publication &&
            (await publication.readCandidate(integrated.workspace) !== integrated.headSha ||
             await publication.readTarget(integrated.workspace) !== integrated.targetSha)) return invalidateCandidate();

        if (parsed.directive === 'revise') {
          if (this.#feedbackLifecycleDependencies !== undefined) {
            const feedbackInputs = feedbackInputsFromPullRequestFinalizeFindings(
              input.runId,
              run.tenant,
              run.owner,
              parsed.findings,
              {
                ids: this.#feedbackLifecycleDependencies.ids,
                clock: this.#feedbackLifecycleDependencies.clock
              }
            );
            for (const fbInput of feedbackInputs) {
              try {
                await this.#feedbackLifecycleDependencies.feedback.create(fbInput);
              } catch (cause) {
                this.#logger?.warn('Failed to persist pr.finalize feedback.', { runId: input.runId, ...this.#safeCause(cause) });
              }
            }
          }
          return apply({
            runId: input.runId,
            directive: 'revise',
            tenant: input.tenant,
            checkpointResult: buildPullRequestFinalizeCheckpoint(parsed, this.#clock !== undefined ? { clock: this.#clock } : {}),
            origin: 'runner'
          });
        }

        // Deterministic spec freeze before advancing to pr.open. Only spec-bearing workflows
        // (feature/enhancement) carry a spec artifact; other workflows skip the freeze.
        // Freeze failure becomes a `fail` directive with reason `spec_freeze_failed` so the
        // run never advances to pr.open with an unfrozen spec.
        let publishSha = integrated?.headSha;
        const isSpecBearingWorkflow = run.workKind === 'feature' || run.workKind === 'enhancement';
        if (isSpecBearingWorkflow && this.#specFreezeDependencies !== undefined) {
          if (this.#resolveWorkspaceContext === undefined) {
            this.#logger?.warn('Spec freeze configured without workspace context resolver.', { runId: input.runId });
            return apply({
              runId: input.runId,
              directive: 'fail',
              tenant: input.tenant,
              reason: 'spec_freeze_failed',
              origin: 'runner'
            });
          }
          if (workspaceForFreeze === undefined) {
            this.#logger?.warn('Failed to resolve workspace context for spec freeze.', { runId: input.runId, ...this.#safeCause(workspaceError) });
            return apply({
              runId: input.runId,
              directive: 'fail',
              tenant: input.tenant,
              reason: 'spec_freeze_failed',
              origin: 'runner'
            });
          }
          try {
            const freeze = await this.#freezeRunSpecForPullRequest(
              { run, workspaceRepoRoot: workspaceForFreeze.workspaceRepoRoot },
              this.#specFreezeDependencies
            );
            if (integrated !== undefined) {
              if (!await publication?.verifyFreeze(integrated.workspace, integrated.headSha, freeze)) {
                return invalidateCandidate();
              }
              publishSha = freeze.commitSha ?? integrated.headSha;
            }
          } catch (cause) {
            const safeCode = cause instanceof SpecFreezeError ? cause.code : 'spec_freeze_failed';
            this.#logger?.warn('Spec freeze failed before pr.open.', { runId: input.runId, code: safeCode, ...this.#safeCause(cause) });
            return apply({
              runId: input.runId,
              directive: 'fail',
              tenant: input.tenant,
              reason: 'spec_freeze_failed',
              origin: 'runner'
            });
          }
        }

        return apply({
          runId: input.runId,
          directive: 'advance',
          tenant: input.tenant,
          checkpointResult: {
            ...buildPullRequestFinalizeCheckpoint(parsed, this.#clock !== undefined ? { clock: this.#clock } : {}) as Record<string, JsonValue>,
            ...(integrated !== undefined && publishSha !== undefined ? {
              attestation: {
                repository: integrated.workspace.repository, branch: integrated.workspace.branch,
                base: integrated.workspace.base, targetSha: integrated.targetSha, reviewedSha: integrated.headSha, publishSha,
                ...(treeSha ? { reviewedTree: treeSha, reviewOccurrenceId: finalizationStepId! } : {})
              },
              integration: { sourceSha: integrated.sourceSha, refreshCount: epoch.count }
            } : {})
          },
          ...(finalizationStepId !== undefined ? { expectedStepId: finalizationStepId } : {}),
          origin: 'runner'
        });
      }

      // For bug spec.author advance: record an issue-canonical bug_triage artifact.
      // Bug triage has no committed spec file and no spec.human_review gate, so this is
      // best-effort and never blocks advancement.
      if (result.directive === 'advance' && run.currentStep === 'spec.author' && run.workKind === 'bug') {
        await this.#recordBugTriageArtifact(input.runId, run);
      }

      const directive: RunDirective = result.directive === 'needs_input' ? 'needs_input' : 'advance';
      const checkpointResult: JsonValue | undefined =
        result.directive === 'advance' && result.result !== undefined
          ? (result.result as JsonValue)
          : undefined;
      return apply({
        runId: input.runId,
        directive,
        tenant: input.tenant,
        ...(checkpointResult !== undefined ? { checkpointResult } : {}),
        origin: 'runner'
      });
    });
  }

  async #dispatchTestingGuide(
    source: DispatchSource,
    commitTransition: CommitDispatchTransition,
    signal: AbortSignal
  ): Promise<OrchestratedRunResult> {
    const { run, runStep } = source;
    const repository = this.#testingGuides;
    if (!repository || !runStep) {
      throw new OrchestratorError('persistence_failed', 'Testing guide persistence or occurrence is unavailable.');
    }
    const scope = { runId: run.id, tenant: run.tenant };
    const previous = await repository.findLatestByRun(scope);
    const authored = previous?.runStepId === runStep.id ? undefined : await authorTestingGuide({
      runId: run.id,
      request: async correction => {
        if (!await this.#dispatchSourceMatches(source) || signal.aborted) throw new StaleDispatchError();
        if (!this.#unitOfWork) throw new OrchestratorError('persistence_failed', 'No unit of work configured.');
        const result = await this.#unitOfWork.run({
          ...scope, run, signal, toolPolicyMode: 'read_only', testingGuidePass: (previous?.revision ?? 0) + 1,
          ...(previous ? { previousTestingGuide: previous } : {}),
          ...(correction ? { testingGuideCorrection: correction } : {})
        });
        if (result.directive === 'cancelled' || signal.aborted) throw new StaleDispatchError();
        return result;
      }
    });
    return commitTransition(async apply => {
      if (authored && 'reason' in authored) {
        return apply({ ...scope, directive: 'fail', origin: 'runner', reason: authored.reason });
      }

      let stored = await repository.findLatestByRun(scope);
      if (stored?.runStepId !== runStep.id) {
        if (!authored) throw new OrchestratorError('persistence_failed', 'Stored testing guide is unavailable.');
        stored = await repository.create({
          ...scope, runStepId: runStep.id, id: randomUUID(),
          revision: (stored?.revision ?? 0) + 1, instructions: authored.guide.instructions,
          items: assignTestingGuideItemIds(stored?.items ?? [], authored.guide.items),
          createdAt: (this.#clock ?? (() => new Date().toISOString()))()
        });
      }
      try {
        return await apply({
          ...scope, expectedStepId: runStep.id, directive: 'advance', origin: 'runner',
          checkpointResult: { kind: 'testing_guide', revision: stored.revision, itemCount: stored.items.length }
        });
      } catch (cause) {
        // A durable guide is the receipt for this occurrence. Leave it open if
        // the transition did not commit; the next admission only advances.
        throw new TestingGuideAdvanceInterrupted(cause);
      }
    });
  }

  #isReviewedProducingStep(stepDefinition: RunStepDefinition): boolean {
    return (
      stepDefinition.id === 'implementation.build' &&
      stepDefinition.waitingOn === 'ai' &&
      stepDefinition.roles.includes('implementer') &&
      stepDefinition.roles.includes('reviewer')
    );
  }

  async #dispatchSystemStep(input: DispatchRunInput, source: DispatchSource,
    apply: Orchestrator['applyDirective'], commitTransition: CommitDispatchTransition): Promise<OrchestratedRunResult> {
    const { run } = source;
    if (run.currentStep === 'intake') {
      return apply({ runId: input.runId, directive: 'advance', tenant: input.tenant, origin: 'system' });
    }

    if (run.currentStep === 'pr.open') {
      if (
        this.#pullRequestOpenDependencies === undefined ||
        this.#runSteps === undefined ||
        this.#runWorkspaceMetadata === undefined
      ) {
        throw new OrchestratorError(
          'persistence_failed',
          'Pull-request open dependencies are not configured.'
        );
      }
      const prDeps = this.#pullRequestOpenDependencies;
      const runSteps = this.#runSteps;
      const runWorkspaceMetadata = this.#runWorkspaceMetadata;
      try {
        const noopRunWorkspaceGit: Pick<RunWorkspaceGitPort, 'getChangedFiles'> = {
          async getChangedFiles() { return []; }
        };
        return await handlePullRequestOpen(input.runId, input.tenant, {
          runs: this.#runs,
          conversations: prDeps.conversations,
          topics: prDeps.topics,
          projects: prDeps.projects,
          pullRequests: prDeps.pullRequests,
          runSteps,
          runWorkspaceMetadata,
          codeHosts: prDeps.codeHosts,
          resolveCredential: prDeps.resolveCredential,
          events: this.#events,
          applyDirective: apply,
          withResultCommit: commitTransition,
          clock: this.#clock ?? (() => new Date().toISOString()),
          runWorkspaceGit: prDeps.runWorkspaceGit ?? noopRunWorkspaceGit,
          ...(prDeps.publicationGit !== undefined ? { publicationGit: prDeps.publicationGit } : {}),
          ...(prDeps.publicationRemoteOverride !== undefined ? { publicationRemoteOverride: prDeps.publicationRemoteOverride } : {})
        });
      } catch (cause) {
        if (cause instanceof StaleDispatchError || this.#transitionConflict(cause) || isWorkflowResolutionFailure(cause) ||
          !await this.#dispatchSourceMatches(source)) throw cause;
        const safeCode = (cause as { code?: string } | null)?.code;
        this.#logger?.warn('pr.open handler failed.', { runId: input.runId, code: safeCode, ...this.#safeCause(cause) });
        if (prDeps.publicationGit !== undefined && (safeCode === 'missing_credential' || safeCode === 'missing_code_host_setting')) {
          const history = await runSteps.listByRun(run.id);
          const prior = publicationEpoch(history);
          const step = history.find(row => row.step === 'pr.open' && row.endedAt === null);
          if (step !== undefined) return apply({
            runId: run.id, tenant: run.tenant, origin: 'system', directive: 'fail',
            expectedStepId: step.id, reason: 'pr_target_verification_failed', checkpointResult: {
              kind: 'publication_stop', code: 'pr_target_verification_failed', timestamp: this.#repairClock(),
              base: initialPullRequestBase, refreshCount: prior.count, sourcePushed: prior.sourcePushed, safeReason: 'binding_unavailable'
            }
          });
        }
        return apply({
          runId: input.runId,
          directive: 'fail',
          tenant: input.tenant,
          reason: typeof safeCode === 'string' ? `pr_open_${safeCode}` : 'pr_open_failed',
          origin: 'system'
        });
      }
    }

    throw new OrchestratorError(
      'invalid_transition',
      `Step '${run.currentStep}' is waiting on a system handler that is not implemented.`
    );
  }

  #repairClock() { return (this.#clock ?? (() => new Date().toISOString()))(); }

  async #moveRepair(input: RepairMove): ReturnType<RepairRepository['move']> {
    const moved = await this.#pullRequestOpenDependencies?.repair?.repository.move(input) ?? null;
    if (moved === null) return null;
    const record = moved.decision;
    this.#logger?.warn('CI repair transition.', {
      event: record.stopCode ?? `repair_${record.state}`, runId: record.runId,
      pullRequestId: record.pullRequestId, head: record.headSha, ordinal: record.ordinal, workspaceHold: record.workspaceHold
    });
    if (moved.transition !== undefined) {
      if (input.nextStep === 'canceled' && moved.transition.run.currentStep === 'canceled') {
        this.#signalCommittedCancellation({ runId: record.runId, tenant: record.tenant });
      }
      const source = input.from.currentStepId === null ? null : await this.#runSteps?.findById(input.from.currentStepId);
      await this.#publishEvent({
        runId: record.runId, tenant: record.tenant,
        directive: input.nextStep === 'canceled' ? 'cancel' : input.nextStep === 'failed' ? 'fail' :
          input.nextStep === 'implementation.awaiting_input' ? 'needs_input' : 'advance',
        ...(source != null ? { fromStep: source.step } : {}),
        toStep: moved.transition.run.currentStep, run: moved.transition.run, runStep: moved.transition.runStep
      });
    }
    return moved;
  }

  #repairWorker(signal?: AbortSignal): RepairWorkerDependencies {
    const deps = this.#pullRequestOpenDependencies;
    if (deps?.repair === undefined || deps.publicationGit === undefined || deps.runWorkspaceGit === undefined ||
        this.#runWorkspaceMetadata === undefined) throw new OrchestratorError('invalid_transition', 'Repair dispatch is not available.');
    const runWorkspaceMetadata = this.#runWorkspaceMetadata;
    return {
      repository: deps.repair.repository, epoch: this.#repairEpoch, git: deps.publicationGit, diff: deps.runWorkspaceGit,
      clock: () => this.#repairClock(),
      pullRequest: async run => {
        const pr = await deps.pullRequests.findByRun(run.id);
        return pr?.tenant === run.tenant ? pr : null;
      },
      workspace: async run => (await resolvePublicationBinding(run, { ...deps, runWorkspaceMetadata })).workspace,
      observe: (run, pr, ci) => readPullRequest(run, pr, this.#pullRequestLifecycleDependencies(), true, Date.now() + 30_000, ci),
      transition: input => this.#withRunMutation(input.from, () => this.#moveRepair(input)),
      onWorkspaceDrained: run => this.#invalidateRepairActivity(run),
      build: async (run, runStep, repair, stillOwns, prBinding) => {
        if (this.#convergenceEngine === undefined || this.#resolveWorkspaceContext === undefined) throw new Error('repair_build_not_configured');
        const workflow = await this.#requireWorkflow({ kind: 'existing_run', run });
        const marker = runStep.checkpointResult as { humanGuidance?: unknown; resumedFromAwaitingInputStepId?: string } | null;
        const guidance = marker?.humanGuidance;
        const history = await this.#runSteps?.listByRun(run.id) ?? [];
        const pause = history.find(step => step.id === marker?.resumedFromAwaitingInputStepId && step.step === 'implementation.awaiting_input');
        const previous = pause === undefined ? [...history].reverse().find(step =>
          step.id !== runStep.id && step.step === 'implementation.build' && convergenceCheckpointSchema.safeParse(step.checkpointResult).success
        ) : history.find(step => step.occurrence.index === pause.occurrence.index - 1 && step.step === 'implementation.build');
        const checkpoint = convergenceCheckpointSchema.safeParse(previous?.checkpointResult);
        return this.#convergenceEngine.run({
          run, runId: run.id, tenant: run.tenant, runStep, workflow, stepDefinition: getRunStepDefinition('implementation.build')!,
          workspace: await this.#resolveWorkspaceContext({ runId: run.id }),
          ...(typeof guidance === 'string' ? { humanGuidance: guidance } : {}),
          ciRepair: { failedHead: repair.headSha, failures: repair.failures, prBinding }, stillOwns,
          ...(signal ? { signal } : {}),
          ...(checkpoint.success ? { priorCheckpoint: checkpoint.data } : {})
        });
      },
      review: async (run, publicationReview) => {
        if (this.#unitOfWork === undefined) throw new Error('repair_review_not_configured');
        return this.#unitOfWork.run({ run, runId: run.id, tenant: run.tenant, toolPolicyMode: 'read_only', publicationReview, ...(signal ? { signal } : {}) });
      }
    };
  }

  async #invalidateRepairActivity(run: Run): Promise<void> {
    try {
      await this.#events.append({ scope: { runId: run.id, tenant: run.tenant }, event: {
        id: `evt_${randomUUID()}`, runId: run.id, step: run.currentStep, importance: 'normal',
        createdAt: this.#repairClock(), type: 'runner_step_checkpoint',
        checkpoint: { durable: true, name: 'pr_ci_activity', data: {} }
      } });
    } catch { /* The durable decision is authoritative. */ }
  }

  #wakeRepair(run: Run, queuedStepId?: string): void {
    void (async () => {
      const stepId = queuedStepId ?? (await this.#runs.findLatestOpenRunStep?.({
        runId: run.id, step: 'implementation.build'
      }))?.id;
      // A guidance reply can queue a different occurrence before the previous
      // dispatch has returned. Deduplicate polling by occurrence, not by run.
      if (stepId === undefined || this.#repairWakeups.has(stepId)) return;
      this.#repairWakeups.add(stepId);
      try {
        const input = { runId: run.id, tenant: run.tenant };
        const occupied = this.#dispatchReservations.get(this.#mutationKey(input));
        if (occupied !== undefined && occupied.runStep?.id !== stepId) {
          await occupied.result.catch(() => undefined);
        }
        const current = await this.#runs.findLatestOpenRunStep?.({ runId: run.id, step: 'implementation.build' });
        if (current?.id !== stepId) return;
        await this.dispatch(input);
      } finally {
        this.#repairWakeups.delete(stepId);
      }
    })().catch(() => undefined);
  }

  async restoreRepairs(): Promise<void> {
    const repository = this.#pullRequestOpenDependencies?.repair?.repository;
    if (repository === undefined) return;
    for (const repair of await repository.listRecoverable()) {
      const run = await this.#runs.findById(repair.runId);
      if (run === null || run.terminal || run.tenant !== repair.tenant) continue;
      if (repair.state === 'queued') this.#wakeRepair(run, repair.currentStepId ?? undefined);
      else if (repair.ownerEpoch !== this.#repairEpoch) {
        try {
          await recoverRepairAttempt(run, repair, this.#repairWorker());
        } catch (error) {
          this.#logger?.warn('CI repair recovery deferred.', { event: 'repair_recovery_deferred', runId: run.id, ...this.#safeCause(error) });
        }
      }
    }
  }

  async workspaceHeld(input: DispatchRunInput): Promise<boolean> {
    const rows = await this.#pullRequestOpenDependencies?.repair?.repository.listByRun(input.runId, input.tenant) ?? [];
    return rows.some(row => row.workspaceHold);
  }

  #pullRequestLifecycleDependencies(): RefreshPullRequestDependencies {
    const deps = this.#pullRequestOpenDependencies;
    if (deps === undefined) {
      throw new OrchestratorError('persistence_failed', 'Pull-request lifecycle dependencies are not configured.');
    }
    const { repair, ...lifecycleDeps } = deps;
    return {
      ...lifecycleDeps,
      ...(repair !== undefined ? { batchCursor: this.#batchCursor, repair: {
        ...repair,
        wake: (run: Run) => this.#wakeRepair(run),
        diagnostic: (event: string, fields: Record<string, unknown>) => this.#logger?.warn('CI repair observation.', { event, ...fields }),
        onTerminal: async (attempt: RepairDecision, state: 'merged' | 'closed') =>
          await this.#moveRepair(repairTerminalMove(attempt, state, this.#repairClock())) !== null,
        onDecision: async (run: Run, decision: RepairDecision, transition?: OrchestratedRunResult) => {
          this.#logger?.warn('CI repair admission decision.', {
            event: decision.stopCode ?? 'repair_queued', runId: run.id, pullRequestId: decision.pullRequestId,
            head: decision.headSha, ordinal: decision.ordinal, limit: decision.limitAtDecision
          });
          if (transition !== undefined) {
            await this.#publishEvent({ runId: run.id, tenant: run.tenant, directive: 'revise',
              fromStep: 'pr.human_review', toStep: transition.run.currentStep, run: transition.run, runStep: transition.runStep });
            this.#wakeRepair(transition.run, transition.runStep.id);
          } else await this.#invalidateRepairActivity(run);
        }
      } } : {}),
      runs: this.#runs,
      applyDirective: (input) => this.applyDirective(input),
      withRunMutation: (input, work) => this.#withRunMutation(input, work),
      ...(this.#clock !== undefined ? { clock: this.#clock } : {})
    };
  }

  async detectMerges(tenant: string, admitCiRepair = false): Promise<PullRequestStatusReconciliationResult> {
    const started = Date.now();
    const result = await detectPullRequestMerges(
      { tenant, maxCount: 50, timeoutMs: 30_000, admitCiRepair },
      this.#pullRequestLifecycleDependencies()
    );
    this.#logger?.info?.('PR reconciliation finished.', {
      event: 'pr_reconciliation_completed', tenant, durationMs: Date.now() - started, ...result
    });
    return result;
  }

  async refreshRunPullRequest(input: DispatchRunInput): Promise<RefreshPullRequestOutcome> {
    return refreshPullRequest(input, this.#pullRequestLifecycleDependencies());
  }

  async admitForDispatch(input: DispatchRunInput): Promise<void> {
    if (!this.#autoDispatchEnabled) return;
    await this.#withRunMutation(input, async (_apply, admit) => {
      const run = await this.#runs.findById(input.runId);
      if (run === null || run.tenant !== input.tenant || run.terminal || !this.#shouldAutoDispatch(run) ||
        this.#dispatchReservations.has(this.#mutationKey(input))) return;
      await admit({ run, runStep: await this.#openRunStep(run) });
    });
  }

  async tick(input: TickInput): Promise<TickResult> {
    // Detect merges as a background side-effect on every tick; failures are swallowed.
    if (this.#pullRequestOpenDependencies !== undefined) {
      this.detectMerges(input.tenant).catch(() => undefined);
    }

    if (input.runId === undefined) {
      return { status: 'noop' };
    }
    let result = await this.dispatch({ runId: input.runId, tenant: input.tenant });

    // Chain through any further system steps the dispatch advanced into, then dispatch
    // the first AI step. This lets tick() drive a freshly-created run (which starts at
    // the 'intake' system step) into its first real unit of work.
    while (!result.run.terminal) {
      const nextStepDef = getRunStepDefinition(result.run.currentStep);
      if (nextStepDef?.waitingOn !== 'system') break;
      result = await this.dispatch({ runId: input.runId, tenant: input.tenant });
    }

    if (!result.run.terminal) {
      const currentStepDef = getRunStepDefinition(result.run.currentStep);
      if (currentStepDef?.waitingOn === 'ai') {
        await this.dispatch({ runId: input.runId, tenant: input.tenant });
      }
    }

    return { status: 'dispatched', runId: input.runId };
  }

  async declineSpecFinding(input: DeclineSpecFindingInput): Promise<Feedback> {
    if (input.principal.kind !== 'human' || input.principal.tenantId !== input.tenant || !input.body.trim()) {
      throw new OrchestratorError('forbidden', 'A human reason is required to decline a finding.');
    }
    return this.#dispatchQueue.enqueueForRun(input.runId, async () => {
      const deps = this.#feedbackLifecycleDependencies;
      if (!this.#runSteps || !deps) throw new OrchestratorError('persistence_failed', 'Spec review feedback is unavailable.');
      const run = await this.#runs.findById(input.runId);
      const item = await deps.feedback.findById(input.feedbackId);
      if (!run || run.tenant !== input.tenant || !item || item.tenant !== input.tenant || item.runId !== run.id) {
        throw new OrchestratorError('missing_run', 'Run or feedback not found.');
      }
      const steps = await this.#runSteps.listByRun(run.id);
      const gate = steps.find(step => step.step === 'spec.human_review' && step.endedAt === null);
      const source = gate && [...steps].sort((a, b) => b.occurrence.index - a.occurrence.index)
        .find(step => step.step === 'spec.author' && step.endedAt !== null && step.occurrence.index < gate.occurrence.index);
      if (!gate || run.terminal || run.currentStep !== 'spec.human_review' ||
          item.target !== 'artifact' || item.status !== 'open' || item.thread[0]?.author.kind !== 'model' ||
          !eligibleSpecFinding(source?.checkpointResult, item.id)) {
        throw new OrchestratorError('invalid_transition', 'The finding is not open at the current bounded spec review gate.');
      }
      const time = deps.clock();
      return deps.feedback.updateStatusAndAppendThread({
        feedbackId: item.id, expectedStatus: 'open', nextStatus: 'wont_fix', updatedAt: time,
        threadEntry: { id: deps.ids(), author: input.principal, body: input.body.trim(), createdAt: time }
      });
    });
  }

  async #observeImplementationGate(input: DispatchRunInput): Promise<RunStep | null> {
    const run = await this.#runs.findById(input.runId);
    if (run === null || run.tenant !== input.tenant) throw new OrchestratorError('missing_run', 'Run not found.');
    return run.currentStep === 'implementation.human_review' && !run.terminal ? this.#openRunStep(run) : null;
  }

  async #requireLiveImplementationGate(input: DispatchRunInput, expected: RunStep | null): Promise<Run> {
    const run = await this.#runs.findById(input.runId);
    if (run === null || run.tenant !== input.tenant) throw new OrchestratorError('missing_run', 'Run not found.');
    if (expected === null || run.terminal || run.currentStep !== 'implementation.human_review' ||
        (await this.#openRunStep(run))?.id !== expected.id) {
      throw new OrchestratorError('conflict', 'The request requires the active implementation review occurrence.');
    }
    return run;
  }

  async saveTestingGuideResults(input: SaveTestingPassInput): Promise<TestingGuideResults> {
    const gate = await this.#observeImplementationGate(input);
    if (gate === null) throw new OrchestratorError('conflict', 'Testing results can only be saved at implementation review.');
    return this.#withRunMutation(input, async () => {
      const run = await this.#requireLiveImplementationGate(input, gate);
      const guides = this.#testingGuides;
      const results = this.#testResults;
      if (!guides || !results) throw new OrchestratorError('persistence_failed', 'Testing results are unavailable.');
      const guide = await guides.findLatestByRun({ runId: run.id, tenant: run.tenant });
      if (guide === null) throw new OrchestratorError('missing_run', 'Testing guide not found.');
      if (guide.revision !== input.request.guideRevision) {
        throw testingPassConflict(new TestingGuidePassConflictError(guide.revision));
      }
      const ids = new Set(guide.items.map(item => item.id));
      const unknownItemIds = input.request.items.filter(item => !ids.has(item.id)).map(item => item.id);
      if (unknownItemIds.length) {
        throw new OrchestratorError('unknown_test_items', 'One or more items are not in the current testing guide.', {
          details: { unknownItemIds }
        });
      }
      const current = await readWorkingTestingGuidePass(guide, gate.id, run.tenant, guides, results);
      try {
        const saved = await results.saveWorking({
          runId: run.id, tenant: run.tenant, gateStepId: gate.id, guideRevision: guide.revision, tester: input.principal,
          items: patchTestingGuideItems(current.items, input.request.items)
        });
        return testingGuidePassView(guide, saved);
      } catch (error) {
        if (error instanceof TestingGuidePassConflictError) throw testingPassConflict(error);
        throw error;
      }
    });
  }

  async createImplementationFeedback(input: CreateImplementationFeedbackInput): Promise<Feedback> {
    const gate = await this.#observeImplementationGate(input);
    return this.#withRunMutation(input, async () => {
      const run = await this.#requireLiveImplementationGate(input, gate);
      const deps = this.#feedbackLifecycleDependencies;
      if (!deps) throw new OrchestratorError('persistence_failed', 'Feedback is unavailable.');
      return createGateFeedback({
        runId: run.id, tenant: run.tenant, owner: run.owner, principal: input.principal,
        target: 'implementation', title: input.title, body: input.body
      }, deps);
    });
  }

  async replyToRun(input: ReplyToRunInput): Promise<ReplyToRunResult> {
    const observedGate = this.#testResults === undefined ? undefined : await this.#observeImplementationGate(input);
    return this.#withRunMutation(input, async (apply) => {
      const run = await this.#runs.findById(input.runId);
      if (run === null) throw new OrchestratorError('missing_run', `Run '${input.runId}' does not exist.`);
      if (run.tenant !== input.tenant) throw new OrchestratorError('forbidden', `Run '${input.runId}' does not belong to tenant '${input.tenant}'.`);
      if (run.terminal) {
        const message = run.currentStep === 'canceled' ? `Run '${run.id}' was canceled and cannot be recovered.`
          : run.currentStep === 'failed' ? `Run '${run.id}' is stopped; use POST /v1/runs/${run.id}/recover to recover it.`
          : `Run '${run.id}' is terminal.`;
        throw new OrchestratorError('terminal_run', message);
      }

      if (input.request.kind === 'guidance') {
        const pauseId = input.request.pauseStepId;
        const history = await this.#runSteps?.listByRun(run.id) ?? [];
        const abandoned = history.some(step =>
          (step.checkpointResult as { abandonedBySetStep?: boolean } | null)?.abandonedBySetStep === true &&
          (pauseId !== undefined ? step.id === pauseId : step.step === 'implementation.awaiting_input' &&
            run.currentStep !== 'spec.awaiting_input'));
        if (abandoned) {
          throw new OrchestratorError('conflict', 'This input request was abandoned. Refresh and supply the current pauseStepId.',
            { details: { code: 'stale_pause' } });
        }
        if (getRunStepDefinition(run.currentStep)?.waitingOn !== 'human') {
          throw new OrchestratorError('conflict', 'Run is not waiting on human input.');
        }
      }

      if (observedGate != null || (observedGate === null && run.currentStep === 'implementation.human_review')) {
        await this.#requireLiveImplementationGate(input, observedGate ?? null);
      }
      if (isHumanReviewGateStep(run.currentStep)) {
        return this.#replyToHumanReviewGate({ ...input, run }, apply, observedGate ?? undefined);
      }

      if (run.currentStep === 'spec.awaiting_input') {
        return this.#replyToSpecQuestion({ ...input, run }, apply);
      }
      if (run.currentStep === 'implementation.awaiting_input') {
        return this.#replyToAwaitingInput({ ...input, run }, apply);
      }

      const currentStepDef = getRunStepDefinition(run.currentStep);
      if (currentStepDef?.waitingOn === 'human') {
        const stale = input.request.kind === 'guidance' && input.request.pauseStepId !== undefined;
        throw new OrchestratorError('invalid_transition', `Step '${run.currentStep}' does not support this reply kind.`,
          stale ? { details: { code: 'stale_pause' } } : {});
      }
      const stale = input.request.kind === 'guidance' && input.request.pauseStepId !== undefined;
      throw new OrchestratorError('invalid_transition', `Run '${input.runId}' is not waiting on human input.`,
        stale ? { details: { code: 'stale_pause' } } : {});
    });
  }

  async #replyToHumanReviewGate(
    input: ReplyToRunInput & { readonly run: Run }, apply: ApplyLockedDirective, gate?: RunStep
  ): Promise<ReplyToRunResult> {
    if (input.request.kind === 'guidance') {
      throw new OrchestratorError('invalid_transition', 'Guidance replies are only supported at an active input pause.',
        input.request.pauseStepId ? { details: { code: 'stale_pause' } } : {});
    }
    if (this.#feedbackLifecycleDependencies === undefined) {
      throw new OrchestratorError('persistence_failed', 'Feedback lifecycle dependencies required for human review replies.');
    }

    if (!isHumanReviewGateStep(input.run.currentStep)) {
      throw new OrchestratorError('invalid_transition', `Reply not supported for step '${input.run.currentStep}'.`);
    }
    const target = getHumanReviewGateFeedbackTarget(input.run.currentStep);

    const results = this.#testResults;
    const guides = this.#testingGuides;
    const guide = gate && results ? await guides?.findLatestByRun(input) : undefined;
    const pass = gate && guide && guides && results
      ? await readWorkingTestingGuidePass(guide, gate.id, input.tenant, guides, results)
      : undefined;
    const failedItemIds = pass?.items.filter(item => item.outcome === 'failed').map(item => item.id) ?? [];
    if (input.request.kind === 'approve' && failedItemIds.length) {
      throw new OrchestratorError('invalid_transition', 'Failed testing items block approval.', {
        details: { code: 'failed_test_items', failedItemIds }
      });
    }

    const commit = (directive: 'revise' | 'advance', decision?: TestingGuidePassDecision) =>
      apply({ runId: input.runId, tenant: input.tenant, directive, origin: 'human', principal: input.principal,
        ...(gate === undefined ? {} : { expectedStepId: gate.id }) },
        gate === undefined ? undefined : { run: input.run, runStep: gate }, decision);

    if (gate && guide && pass && input.request.kind !== 'approve') {
      const deps = this.#feedbackLifecycleDependencies;
      if (input.request.kind === 'request_changes' && failedItemIds.length === 0 &&
          !(await deps.feedback.listByRun(input.runId)).some(item => item.target === 'implementation' && item.status === 'open')) {
        throw new OrchestratorError('invalid_transition', 'There is no open implementation feedback and no failed check.', {
          details: { code: 'request_changes_conflict' }
        });
      }
      const planFeedback = (title: string, body: string, anchor?: Feedback['anchor']) => ({
        id: `fb_${randomUUID()}`,
        input: buildGateFeedback({
          runId: input.runId, tenant: input.tenant, owner: input.run.owner,
          principal: input.principal, target, title, body, ...(anchor === undefined ? {} : { anchor })
        }, deps)
      });
      const replyFeedback = input.request.kind === 'feedback'
        ? planFeedback(input.request.title, input.request.body, input.request.anchor) : undefined;
      const failures = guide.items.flatMap((item, index) => {
        const mark = pass.items[index];
        if (mark?.outcome !== 'failed' || mark.feedbackId !== undefined) return [];
        return [{ itemId: item.id, ...planFeedback(item.text, failedTestingItemFeedbackBody(item, mark.note)) }];
      });
      const moved = await commit('revise', {
        action: 'revise',
        pass: { runId: input.runId, tenant: input.tenant, gateStepId: gate.id, guideRevision: guide.revision,
          tester: input.principal, items: pass.items },
        ...(pass.testResultId === undefined ? {} : { workingResultId: pass.testResultId }),
        ...(replyFeedback === undefined ? {} : { replyFeedback }),
        failures
      });
      return { ...moved, classification: { directive: 'revise', target,
        ...(replyFeedback === undefined ? {} : { createdFeedbackId: replyFeedback.id }) } };
    }

    if (input.request.kind === 'request_changes') {
      // Request changes operates over feedback already raised; it creates no item. It applies the
      // revise directive at a human-review gate (spec or implementation) when at least one open
      // feedback item exists for that gate's target. When no open feedback exists for the target,
      // it is a conflict (mapped to 409), matching other inapplicable replies. The target is
      // resolved per gate step by getHumanReviewGateFeedbackTarget above.
      const items = await this.#feedbackLifecycleDependencies.feedback.listByRun(input.run.id);
      const openForTarget = items.filter((item) => item.target === target && item.status === 'open');
      if (openForTarget.length === 0) {
        throw new OrchestratorError(
          'invalid_transition',
          `No open feedback exists for '${target}'; raise feedback before requesting changes.`,
          { details: { code: 'request_changes_conflict' } }
        );
      }
      const moved = await commit('revise');
      // Intentionally no createdFeedbackId: request_changes operates over existing comments.
      return { ...moved, classification: { directive: 'revise', target } };
    }

    if (input.request.kind === 'feedback') {
      const feedback = await createGateFeedback({
        runId: input.run.id,
        owner: input.run.owner,
        tenant: input.run.tenant,
        principal: input.principal,
        target,
        title: input.request.title,
        body: input.request.body,
        ...(input.request.anchor !== undefined ? { anchor: input.request.anchor } : {})
      }, this.#feedbackLifecycleDependencies);
      const moved = await commit('revise');
      return { ...moved, classification: { directive: 'revise', target, createdFeedbackId: feedback.id } };
    }

    // approve
    // For spec.human_review: applyDirective already handles co-resolution, gate check, and finalizer.
    // For implementation.human_review: we must do co-resolution and gate check here since applyDirective doesn't handle them.
    if (input.run.currentStep === 'implementation.human_review') {
      await resolveApproverAddressedFeedback(
        { runId: input.run.id, target, approver: input.principal },
        this.#feedbackLifecycleDependencies
      );
      try {
        await assertHumanReviewGateCanAdvance({ run: input.run, target }, {
          listBlockingFeedback: (listInput) => listBlockingFeedback(listInput, this.#feedbackLifecycleDependencies!)
        });
      } catch (error) {
        if (error instanceof HumanReviewGateError && error.code === 'feedback_gate_blocked') {
          throw new OrchestratorError('invalid_transition', 'Feedback blocks review approval.', {
            cause: error,
            details: { code: 'feedback_gate_blocked', blockingFeedbackIds: error.blockingFeedbackIds }
          });
        }
        throw error;
      }
    }

    const moved = await commit('advance', gate && guide && pass ? {
      action: 'approve',
      pass: { runId: input.runId, tenant: input.tenant, gateStepId: gate.id, guideRevision: guide.revision,
        tester: input.principal, items: pass.items },
      ...(pass.testResultId === undefined ? {} : { workingResultId: pass.testResultId })
    } : undefined);
    return { ...moved, classification: { directive: 'advance', target } };
  }

  async #replyToSpecQuestion(input: ReplyToRunInput & { readonly run: Run }, apply: ApplyLockedDirective): Promise<ReplyToRunResult> {
    if (input.principal.kind !== 'human' || input.request.kind !== 'guidance' || !input.request.body.trim()) {
      throw new OrchestratorError('invalid_transition', 'Only human guidance is supported at spec.awaiting_input.');
    }
    const steps = await this.#runSteps?.listByRun(input.runId);
    const active = steps?.find(step => step.step === 'spec.awaiting_input' && step.endedAt === null);
    const pause = (active?.checkpointResult as { pause?: SpecQuestionPause } | null)?.pause;
    if (!active || pause?.kind !== 'spec_question' || input.request.pauseStepId !== active.id) {
      throw new OrchestratorError('invalid_transition', 'The spec question is stale or was already answered.', { details: { code: 'stale_pause' } });
    }
    const moved = await apply({
      runId: input.runId, tenant: input.tenant, directive: 'advance', origin: 'human', principal: input.principal,
      destinationCheckpointResult: { specAnswer: { sourceStepId: pause.sourceStepId, role: pause.role, body: input.request.body } }
    }, { run: input.run, runStep: active });
    return { ...moved, classification: { directive: 'advance', pauseKind: 'spec_question' } };
  }

  async #replyToAwaitingInput(input: ReplyToRunInput & { readonly run: Run }, apply: ApplyLockedDirective): Promise<ReplyToRunResult> {
    if (input.request.kind !== 'guidance') {
      throw new OrchestratorError('invalid_transition', 'Only guidance replies are supported at implementation.awaiting_input.');
    }
    if (this.#runSteps === undefined) {
      throw new OrchestratorError('persistence_failed', 'Run step repository required for awaiting-input replies.');
    }
    const repairRepository = this.#pullRequestOpenDependencies?.repair?.repository;
    if (repairRepository !== undefined) {
      const repair = findCurrentRepair(await repairRepository.listByRun(input.runId, input.tenant));
      if (repair !== undefined) {
        const body = input.request.body;
        if (input.principal.kind !== 'human' || repair.state !== 'awaiting_human' ||
            input.request.pauseStepId === undefined || input.request.pauseStepId !== repair.currentStepId) {
          throw new OrchestratorError('invalid_transition', 'The repair guidance reply is stale or unauthorized.');
        }
        const pause = await getConvergenceEscalationPause(
          { run: input.run, expectedStepId: 'implementation.awaiting_input' }, { runSteps: this.#runSteps });
        if (pause.runStep.id !== repair.currentStepId) throw new OrchestratorError('invalid_transition', 'The repair pause changed.');
        const moved = await this.#moveRepair({
          from: repair, state: 'queued', now: this.#repairClock(), nextStep: 'implementation.build',
          checkpoint: { pause: { ...pause.checkpoint.pause, humanGuidance: body } },
          initialCheckpoint: { resumedFromAwaitingInputStepId: pause.runStep.id, humanGuidance: body }
        });
        if (moved?.transition === undefined) throw new OrchestratorError('invalid_transition', 'The repair pause changed.');
        this.#wakeRepair(moved.transition.run, moved.transition.runStep.id);
        return { ...moved.transition, classification: { directive: 'advance', pauseKind: 'convergence_escalation' } };
      }
    }
    let pause: Awaited<ReturnType<typeof getConvergenceEscalationPause>>;
    try {
      pause = await getConvergenceEscalationPause(
        { run: input.run, expectedStepId: 'implementation.awaiting_input' },
        { runSteps: this.#runSteps }
      );
      if (input.request.pauseStepId !== undefined && input.request.pauseStepId !== pause.runStep.id) {
        throw new OrchestratorError('conflict', 'The guidance reply is stale.', { details: { code: 'stale_pause' } });
      }
      if (pause.runStep.endedAt !== null) {
        throw new OrchestratorError('conflict', 'The guidance reply is stale.', { details: { code: 'stale_pause' } });
      }
    } catch (error) {
      if (error instanceof ConvergenceCheckpointError && error.code === 'invalid_pause') {
        throw new OrchestratorError('invalid_transition', 'Unsupported awaiting-input pause.', { details: { code: 'unsupported_pause' }, cause: error });
      }
      throw error;
    }
    const moved = await apply({
      runId: input.runId,
      tenant: input.tenant,
      directive: 'advance',
      origin: 'human',
      principal: input.principal,
      checkpointResult: { ...pause.checkpoint, pause: { ...pause.checkpoint.pause, humanGuidance: input.request.body } },
      destinationCheckpointResult: {
        resumedFromAwaitingInputStepId: pause.runStep.id,
        humanGuidance: input.request.body
      }
    }, { run: input.run, runStep: pause.runStep });
    return { ...moved, classification: { directive: 'advance', pauseKind: 'convergence_escalation' } };
  }

  #shouldAutoDispatch(run: Run): boolean {
    const stepDefinition = getRunStepDefinition(run.currentStep);
    if (stepDefinition === null) {
      this.#logger?.warn('Unknown run step encountered while evaluating auto-dispatch eligibility.', {
        runId: run.id,
        tenant: run.tenant,
        currentStep: run.currentStep
      });
      return false;
    }
    return stepDefinition.waitingOn === 'system' || stepDefinition.waitingOn === 'ai';
  }

  async #handleAutoDispatchFailure(run: Run, error: unknown, apply: Orchestrator['applyDirective']): Promise<void> {
    const code = error instanceof OrchestratorError ? error.code : 'unexpected_error';
    this.#logger?.warn('Auto-dispatch failed after a committed run transition.', {
      runId: run.id,
      tenant: run.tenant,
      currentStep: run.currentStep,
      code,
      errorName: error instanceof Error ? error.name : typeof error
    });

    if (isWorkflowResolutionFailure(error) || this.#isExpectedAutoDispatchFailure(error)) {
      return;
    }

    let current: Run | null;
    try {
      current = await this.#runs.findById(run.id);
    } catch (readError) {
      this.#logger?.warn('Failed to read run after auto-dispatch failure.', {
        runId: run.id,
        tenant: run.tenant,
        code: readError instanceof OrchestratorError ? readError.code : 'read_failed'
      });
      return;
    }

    if (current === null || current.tenant !== run.tenant || current.terminal || !this.#shouldAutoDispatch(current)) {
      return;
    }

    const publicReason = safeFailureReasonFromError(error) ?? 'auto_dispatch_failed';
    try {
      await apply({ runId: run.id, tenant: run.tenant, directive: 'fail', reason: publicReason });
    } catch (failError) {
      if (failError instanceof StaleDispatchError || this.#transitionConflict(failError)) return;
      const failCode = failError instanceof OrchestratorError ? failError.code : 'unexpected_error';
      if (failError instanceof OrchestratorError && this.#isExpectedAutoDispatchFailure(failError)) {
        this.#logger?.warn('Auto-dispatch failure was not applied because run state changed.', {
          runId: run.id,
          tenant: run.tenant,
          code: failCode
        });
        return;
      }
      this.#logger?.warn('Failed to mark run failed after auto-dispatch rejection.', {
        runId: run.id,
        tenant: run.tenant,
        code: failCode,
        message: this.#safeFailureMessage(failError)
      });
    }
  }

  #safeFailureMessage(error: unknown): string {
    if (error instanceof OrchestratorError) {
      return error.code;
    }
    if (error instanceof Error) {
      return error.name;
    }
    return typeof error;
  }

  #safeCause(error: unknown): { errorName: string; code?: string } {
    if (error instanceof OrchestratorError) {
      return { errorName: error.name, code: error.code };
    }
    if (error instanceof Error && 'code' in error && typeof (error as { code: unknown }).code === 'string') {
      return { errorName: error.name, code: (error as { code: string }).code };
    }
    if (error instanceof Error) {
      return { errorName: error.name };
    }
    return { errorName: typeof error };
  }

  #isExpectedAutoDispatchFailure(error: unknown): boolean {
    return error instanceof OrchestratorError && (
      error.code === 'missing_run' ||
      error.code === 'forbidden' ||
      error.code === 'terminal_run' ||
      error.code === 'invalid_transition'
    );
  }

  /**
   * Record an issue-canonical bug_triage artifact for a bug run that completed
   * spec.author. Bug triage is the tracker issue's source of truth, so the artifact
   * carries `canonicalRecord: 'issue'` and no committed spec file. Best-effort: a
   * missing dependency or a persistence failure is logged and never blocks the run.
   */
  async #recordBugTriageArtifact(runId: string, run: Run): Promise<void> {
    const artifacts = this.#specAuthoringDependencies?.artifacts;
    if (artifacts === undefined) {
      return;
    }
    try {
      const existing = await artifacts.findByRunAndKind({ runId, kind: 'bug_triage' });
      if (existing !== null && existing !== undefined) {
        return;
      }
      const location = run.trackedIssue?.url ?? `issue:${run.trackedIssue?.number ?? 'unknown'}`;
      await artifacts.create({
        runId,
        owner: run.owner,
        tenant: run.tenant,
        kind: 'bug_triage',
        canonicalRecord: 'issue',
        location,
        cachedStatus: 'draft',
        ...(run.trackedIssue !== undefined ? { linkedIssue: run.trackedIssue } : {}),
        publicationRefs: []
      });
    } catch (cause) {
      this.#logger?.warn('Failed to record bug_triage artifact; continuing.', { runId, ...this.#safeCause(cause) });
    }
  }

  async #runSpecAuthoringCompletion(
    runId: string,
    run: Run,
    result: SpecAuthorResult,
    reviewedMarkdown: string,
    workspaceContext: WorkspaceContext
  ): Promise<{ kind: 'ok'; output: CompleteSpecAuthoringOutput } | { kind: 'failed' }> {
    if (this.#specAuthoringDependencies === undefined || this.#resolveWorkspaceContext === undefined) {
      this.#logger?.warn('spec.author advanced but specAuthoringDependencies or resolveWorkspaceContext not configured.', { runId });
      return { kind: 'failed' };
    }

    try {
      const output = await completeSpecAuthoring(
        {
          run,
          result,
          reviewedMarkdown,
          workspaceRepoRoot: workspaceContext.workspaceRepoRoot,
          workspaceHandle: workspaceContext.workspaceHandle
        },
        this.#specAuthoringDependencies
      );

      // Persist workspace root for restart recovery — stored in internal-only
      // metadata and never included in public RunStep checkpoints or API responses.
      // Durable metadata is required: approval finalization resolves the workspace
      // context from it after a restart, so a persist failure fails the step rather
      // than advancing the run into the gate with no recoverable record.
      if (this.#runWorkspaceMetadata !== undefined) {
        try {
          await this.#runWorkspaceMetadata.upsert({
            runId,
            workspaceHandle: workspaceContext.workspaceHandle,
            workspaceRepoRoot: workspaceContext.workspaceRepoRoot,
            createdAt: this.#clock?.() ?? new Date().toISOString()
          });
        } catch (persistCause) {
          this.#logger?.warn('Failed to persist workspace metadata for run; failing spec.author completion.', { runId, ...this.#safeCause(persistCause) });
          return { kind: 'failed' };
        }
      }

      return { kind: 'ok', output };
    } catch (cause) {
      this.#logger?.warn('spec.author completion service failed.', { runId, ...this.#safeCause(cause) });
      return { kind: 'failed' };
    }
  }

  async #publishEvent(args: {
    runId: string;
    directive: RunStateTransitionKind;
    fromStep?: string;
    toStep: string;
    run: Run;
    runStep: RunStep;
    tenant: string;
    reason?: string;
  }): Promise<void> {
    const event = createRunStateTransitionEvent({
      runId: args.runId,
      directive: args.directive,
      ...(args.fromStep !== undefined ? { fromStep: args.fromStep } : {}),
      toStep: args.toStep,
      ...(args.reason !== undefined ? { reason: args.reason } : {}),
      run: args.run,
      runStep: args.runStep,
      tenant: args.tenant,
      ...(this.#eventIdGenerator !== undefined ? { idGenerator: this.#eventIdGenerator } : {}),
      ...(this.#clock !== undefined ? { clock: this.#clock } : {})
    });
    try {
      await this.#events.append({
        scope: { runId: args.runId, tenant: args.tenant },
        event
      });
    } catch (error) {
      // Post-commit append failures must not fail the API call — the lifecycle
      // already advanced; we just lose the live stream notification.
      this.#logger?.warn('Failed to append run state transition event after commit.', { runId: args.runId, ...this.#safeCause(error) });
    }
  }

  async #requireWorkflow(input: RunWorkflowResolverInput): Promise<RunWorkflowDefinition> {
    try {
      return await requireRunWorkflow(input, this.#workflowResolver);
    } catch (error) {
      if (error instanceof RunLifecycleError) throw this.#mapLifecycleError(error);
      throw error;
    }
  }

  #mapLifecycleError(error: RunLifecycleError): OrchestratorError {
    switch (error.code) {
      case 'unknown_work_kind':
        return new OrchestratorError('unknown_work_kind', error.message, { cause: error });
      case 'missing_run':
        return new OrchestratorError('missing_run', error.message, { cause: error });
      case 'terminal_run':
        return new OrchestratorError('terminal_run', error.message, { cause: error });
      case 'invalid_transition':
        return new OrchestratorError('invalid_transition', error.message, {
          cause: error,
          ...(error.transitionCode !== undefined ? { details: { transitionCode: error.transitionCode } } : {})
        });
      case 'source_step_mismatch':
      case 'source_occurrence_mismatch':
        return new OrchestratorError('conflict', error.message, { cause: error, details: { reason: error.message } });
      case 'unknown_workflow':
      case 'start_persistence_failed':
      case 'transition_persistence_failed':
        return new OrchestratorError('persistence_failed', error.message, { cause: error });
      default:
        return new OrchestratorError('persistence_failed', error.message, { cause: error });
    }
  }
}
