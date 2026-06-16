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
  Topic,
  TrackedIssue
} from '@autocatalyst/api-contract';

import { normalizeFailureReasonForPublicSurface } from '@autocatalyst/execution';

import type { CompleteSpecAuthoringOutput, SpecAuthoringServiceDependencies } from './spec-authoring-service.js';
import { completeSpecAuthoring } from './spec-authoring-service.js';
import type { SpecApprovalFinalizerDependencies } from './spec-approval-finalizer.js';
import { finalizeSpecApproval } from './spec-approval-finalizer.js';
import type { ConvergenceEngine } from './convergence-engine.js';
import {
  ConvergenceCheckpointError,
  getConvergenceEscalationPause,
  recordConvergenceEscalationGuidance
} from './convergence-checkpoint.js';

import type {
  ConversationIngressRepository,
  CreateConversationTopicMessageAndRunResult,
  LifecycleRunStepInput,
  RunRepository,
  RunStepRepository,
  RunWorkspaceMetadataRepository
} from './domain-repositories.js';
import type { FeedbackLifecycleDependencies } from './feedback-lifecycle.js';
import { createGateFeedback, listBlockingFeedback, resolveApproverAddressedFeedback } from './feedback-lifecycle.js';
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
  RunLifecycleError,
  startRunLifecycle,
  type RunLifecycleState
} from './run-lifecycle.js';
import { deriveRunTerminal, getRunStepDefinition, type RunStepDefinition } from './run-step-catalog.js';
import { getRunWorkflowForWorkKind, type RunDirective } from './run-workflows.js';
import { safeFailureReasonFromError } from './safe-failure-reason.js';

// --- Error types ---

export type OrchestratorErrorCode =
  | 'active_run_conflict'
  | 'missing_run'
  | 'terminal_run'
  | 'invalid_transition'
  | 'unknown_work_kind'
  | 'forbidden'
  | 'persistence_failed';

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
  readonly runId: string;
  readonly run: Run;
  readonly tenant: string;
}

export type RunWorkResult =
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
  readonly principal?: NonModelPrincipal;
  readonly reason?: string;
  readonly origin?: 'runner' | 'human' | 'system';
}

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

export interface Orchestrator {
  createRun(input: CreateOrchestratedRunInput): Promise<OrchestratedRunResult>;
  createConversationWithFirstRun(input: CreateOrchestratedConversationInput): Promise<OrchestratedConversationResult>;
  applyDirective(input: ApplyOrchestratedDirectiveInput): Promise<OrchestratedRunResult>;
  dispatch(input: DispatchRunInput): Promise<OrchestratedRunResult>;
  tick(input: TickInput): Promise<TickResult>;
  replyToRun(input: ReplyToRunInput): Promise<ReplyToRunResult>;
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
  readonly runs: RunRepository;
  readonly conversationIngress: ConversationIngressRepository;
  readonly events: RunEventStore;
  readonly dispatchQueue: RunDispatchQueue;
  readonly unitOfWork?: RunUnitOfWork;
  readonly clock?: () => string;
  readonly eventIdGenerator?: () => string;
  readonly isActiveRunConflict?: (error: unknown) => boolean;
  readonly logger?: { warn(message: string, details?: unknown): void };
  readonly specAuthoringDependencies?: SpecAuthoringServiceDependencies;
  readonly resolveWorkspaceContext?: WorkspaceContextResolver;
  readonly runWorkspaceMetadata?: RunWorkspaceMetadataRepository;
  readonly resolveApproverAddressedFeedback?: typeof resolveApproverAddressedFeedback;
  readonly assertSpecReviewGateCanAdvance?: typeof assertSpecReviewGateCanAdvance;
  readonly feedbackLifecycleDependencies?: FeedbackLifecycleDependencies;
  readonly finalizeSpecApproval?: typeof finalizeSpecApproval;
  readonly specApprovalFinalizerDependencies?: SpecApprovalFinalizerDependencies;
  readonly runSteps?: RunStepRepository;
  readonly convergenceEngine?: ConvergenceEngine;
  readonly autoDispatch?: AutoDispatchOptions;
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

// --- Implementation ---

export class DefaultOrchestrator implements Orchestrator {
  readonly #runs: RunRepository;
  readonly #conversationIngress: ConversationIngressRepository;
  readonly #events: RunEventStore;
  readonly #dispatchQueue: RunDispatchQueue;
  readonly #unitOfWork: RunUnitOfWork | undefined;
  readonly #clock: (() => string) | undefined;
  readonly #eventIdGenerator: (() => string) | undefined;
  readonly #isActiveRunConflict: (error: unknown) => boolean;
  readonly #logger: { warn(message: string, details?: unknown): void } | undefined;
  readonly #specAuthoringDependencies: SpecAuthoringServiceDependencies | undefined;
  readonly #resolveWorkspaceContext: WorkspaceContextResolver | undefined;
  readonly #runWorkspaceMetadata: RunWorkspaceMetadataRepository | undefined;
  readonly #resolveApproverAddressedFeedback: typeof resolveApproverAddressedFeedback;
  readonly #assertSpecReviewGateCanAdvance: typeof assertSpecReviewGateCanAdvance;
  readonly #feedbackLifecycleDependencies: FeedbackLifecycleDependencies | undefined;
  readonly #finalizeSpecApproval: typeof finalizeSpecApproval;
  readonly #specApprovalFinalizerDependencies: SpecApprovalFinalizerDependencies | undefined;
  readonly #runSteps: RunStepRepository | undefined;
  readonly #convergenceEngine: ConvergenceEngine | undefined;
  readonly #autoDispatchEnabled: boolean;
  readonly #autoDispatchInFlightRunIds = new Set<string>();

  constructor(options: DefaultOrchestratorOptions) {
    this.#runs = options.runs;
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
    this.#runSteps = options.runSteps;
    this.#convergenceEngine = options.convergenceEngine;
  }

  async createRun(input: CreateOrchestratedRunInput): Promise<OrchestratedRunResult> {
    let state: RunLifecycleState;
    try {
      state = await startRunLifecycle({
        runs: this.#runs,
        run: input,
        ...(this.#clock !== undefined ? { clock: this.#clock } : {})
      });
    } catch (error) {
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

    await this.#publishEvent({
      runId: state.run.id,
      directive: 'start',
      toStep: state.run.currentStep,
      run: state.run,
      runStep: state.runStep,
      tenant: state.run.tenant
    });

    this.#scheduleAutoDispatch(state.run);

    return { run: state.run, runStep: state.runStep };
  }

  async createConversationWithFirstRun(
    input: CreateOrchestratedConversationInput
  ): Promise<OrchestratedConversationResult> {
    const workflow = getRunWorkflowForWorkKind(input.workKind);
    if (workflow === null) {
      throw new OrchestratorError('unknown_work_kind', `Unknown work kind '${input.workKind}'.`);
    }
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

    await this.#publishEvent({
      runId: result.run.id,
      directive: 'start',
      toStep: result.run.currentStep,
      run: result.run,
      runStep: result.runStep,
      tenant: result.run.tenant
    });

    this.#scheduleAutoDispatch(result.run);

    return result;
  }

  async applyDirective(input: ApplyOrchestratedDirectiveInput): Promise<OrchestratedRunResult> {
    const existing = await this.#runs.findById(input.runId);
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
    const normalizedFailureReason = input.directive === 'fail'
      ? normalizeFailureReasonForPublicSurface(input.reason)
      : undefined;

    const origin = input.origin ?? 'runner';

    // Defense-in-depth: block any advance directive from runner origin when run is at a human gate.
    // spec.human_review is excluded here because it was originally handled as a special case before
    // full human-origin support was added; now both gates are guarded by the origin check.
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
        runId: input.runId,
        directive: input.directive,
        ...(input.checkpointResult !== undefined ? { checkpointResult: input.checkpointResult } : {}),
        ...(normalizedFailureReason !== undefined ? { reason: normalizedFailureReason } : {}),
        ...(this.#clock !== undefined ? { clock: this.#clock } : {})
      });
    } catch (error) {
      if (error instanceof RunLifecycleError) {
        throw this.#mapLifecycleError(error);
      }
      throw new OrchestratorError('persistence_failed', 'Failed to apply directive.', {
        cause: error
      });
    }

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

    this.#scheduleAutoDispatch(state.run);

    return { run: state.run, runStep: state.runStep };
  }

  async dispatch(input: DispatchRunInput): Promise<OrchestratedRunResult> {
    const run = await this.#runs.findById(input.runId);
    if (run === null) {
      throw new OrchestratorError('missing_run', `Run '${input.runId}' does not exist.`);
    }
    if (run.tenant !== input.tenant) {
      throw new OrchestratorError('forbidden', `Run '${input.runId}' does not belong to tenant '${input.tenant}'.`);
    }
    if (run.terminal) {
      throw new OrchestratorError('terminal_run', `Run '${input.runId}' is terminal.`);
    }

    const stepDefinition = getRunStepDefinition(run.currentStep);
    if (stepDefinition?.waitingOn === 'human') {
      throw new OrchestratorError(
        'invalid_transition',
        `Step '${run.currentStep}' is waiting on human input and cannot be dispatched to a runner.`
      );
    }

    if (stepDefinition?.waitingOn === 'system') {
      return this.#dispatchSystemStep(input, run);
    }

    // implementation.plan deterministic passthrough: records an explicit checkpoint and advances
    // to implementation.build without dispatching an AI prompt.
    if (run.currentStep === 'implementation.plan') {
      return this.#dispatchQueue.enqueueForRun(input.runId, async () => this.applyDirective({
        runId: input.runId,
        tenant: input.tenant,
        directive: 'advance',
        origin: 'system',
        checkpointResult: {
          kind: 'implementation_plan_passthrough',
          reason: 'issue_63_reply_ingress_uses_existing_build_convergence'
        }
      }));
    }

    if (stepDefinition !== null && this.#isReviewedProducingStep(stepDefinition) && this.#convergenceEngine !== undefined) {
      const convergenceEngine = this.#convergenceEngine;
      return this.#dispatchQueue.enqueueForRun(input.runId, async () => {
        const workflow = getRunWorkflowForWorkKind(run.workKind);
        if (workflow === null) {
          throw new OrchestratorError('unknown_work_kind', `Unknown work kind '${run.workKind}'.`);
        }
        const runSteps = this.#runSteps !== undefined ? await this.#runSteps.listByRun(input.runId) : [];
        const runStep = runSteps.find(s => s.step === run.currentStep) ?? {
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
        const awaitingInputStep = [...runSteps].reverse().find(s => s.step === 'implementation.awaiting_input' && s.endedAt !== null);
        const humanGuidance: string | undefined = (() => {
          if (awaitingInputStep?.checkpointResult == null) return undefined;
          const cp = awaitingInputStep.checkpointResult as { pause?: { kind?: string; humanGuidance?: string } };
          return cp.pause?.kind === 'convergence_escalation' && typeof cp.pause.humanGuidance === 'string'
            ? cp.pause.humanGuidance
            : undefined;
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
          ...(resolvedWorkspace !== undefined ? { workspace: resolvedWorkspace } : {}),
          ...(humanGuidance !== undefined ? { humanGuidance } : {})
        });

        if (result.workResult.directive === 'fail') {
          const reason = result.workResult.reason;
          return this.applyDirective({ runId: input.runId, directive: 'fail', tenant: input.tenant, reason, origin: 'runner' });
        }
        if (result.workResult.directive === 'needs_input') {
          return this.applyDirective({
            runId: input.runId,
            directive: 'needs_input',
            tenant: input.tenant,
            checkpointResult: result.checkpointResult as unknown as JsonValue,
            origin: 'runner'
          });
        }
        return this.applyDirective({
          runId: input.runId,
          directive: 'advance',
          tenant: input.tenant,
          checkpointResult: result.checkpointResult as unknown as JsonValue,
          origin: 'runner'
        });
      });
    }

    if (this.#unitOfWork === undefined) {
      throw new OrchestratorError('persistence_failed', 'No unit of work configured.');
    }
    const unitOfWork = this.#unitOfWork;

    return this.#dispatchQueue.enqueueForRun(input.runId, async () => {
      const result = await unitOfWork.run({ runId: input.runId, run, tenant: input.tenant });
      if (result.directive === 'fail') {
        return this.applyDirective({ runId: input.runId, directive: 'fail', tenant: input.tenant, reason: result.reason, origin: 'runner' });
      }
      if (result.directive === 'needs_input') {
        const workflow = getRunWorkflowForWorkKind(run.workKind);
        const hasNeedsInputEdge =
          workflow !== null &&
          (workflow.transitions as Record<string, Record<string, string> | undefined>)[run.currentStep]?.['needs_input'] !== undefined;
        if (!hasNeedsInputEdge) {
          throw new OrchestratorError(
            'invalid_transition',
            `Step '${run.currentStep}' in workflow '${run.workKind}' has no 'needs_input' edge.`
          );
        }
      }

      // For spec.author advance: run completion service before persisting transition.
      if (result.directive === 'advance' && run.currentStep === 'spec.author' && (run.workKind === 'feature' || run.workKind === 'enhancement')) {
        const completionResult = await this.#runSpecAuthoringCompletion(input.runId, run, result.result);
        if (completionResult.kind === 'failed') {
          return this.applyDirective({ runId: input.runId, directive: 'fail', tenant: input.tenant, reason: 'spec_authoring_failed', origin: 'runner' });
        }
        return this.applyDirective({
          runId: input.runId,
          directive: 'advance',
          tenant: input.tenant,
          checkpointResult: completionResult.checkpointResult as JsonValue,
          origin: 'runner'
        });
      }

      const directive: RunDirective = result.directive === 'needs_input' ? 'needs_input' : 'advance';
      const checkpointResult: JsonValue | undefined =
        result.directive === 'advance' && result.result !== undefined
          ? (result.result as JsonValue)
          : undefined;
      return this.applyDirective({
        runId: input.runId,
        directive,
        tenant: input.tenant,
        ...(checkpointResult !== undefined ? { checkpointResult } : {}),
        origin: 'runner'
      });
    });
  }

  #isReviewedProducingStep(stepDefinition: RunStepDefinition): boolean {
    // Scoped to implementation.build only. spec.author also carries both roles but has
    // a spec-artifact completion step (#runSpecAuthoringCompletion) that must run after
    // convergence — that wiring is tracked separately; until then keep it on the one-shot path.
    return (
      stepDefinition.id === 'implementation.build' &&
      stepDefinition.waitingOn === 'ai' &&
      stepDefinition.roles.includes('implementer') &&
      stepDefinition.roles.includes('reviewer')
    );
  }

  async #dispatchSystemStep(input: DispatchRunInput, run: Run): Promise<OrchestratedRunResult> {
    if (run.currentStep === 'intake') {
      return this.applyDirective({ runId: input.runId, directive: 'advance', tenant: input.tenant, origin: 'system' });
    }

    throw new OrchestratorError(
      'invalid_transition',
      `Step '${run.currentStep}' is waiting on a system handler that is not implemented.`
    );
  }

  async tick(input: TickInput): Promise<TickResult> {
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

  async replyToRun(input: ReplyToRunInput): Promise<ReplyToRunResult> {
    return this.#dispatchQueue.enqueueForRun(input.runId, async () => {
      const run = await this.#runs.findById(input.runId);
      if (run === null) throw new OrchestratorError('missing_run', `Run '${input.runId}' does not exist.`);
      if (run.tenant !== input.tenant) throw new OrchestratorError('forbidden', `Run '${input.runId}' does not belong to tenant '${input.tenant}'.`);
      if (run.terminal) throw new OrchestratorError('terminal_run', `Run '${input.runId}' is terminal.`);

      if (isHumanReviewGateStep(run.currentStep)) {
        return this.#replyToHumanReviewGate({ ...input, run });
      }

      if (run.currentStep === 'implementation.awaiting_input') {
        return this.#replyToAwaitingInput({ ...input, run });
      }

      const currentStepDef = getRunStepDefinition(run.currentStep);
      if (currentStepDef?.waitingOn === 'human') {
        throw new OrchestratorError('invalid_transition', `Step '${run.currentStep}' does not support this reply kind.`);
      }
      throw new OrchestratorError('invalid_transition', `Run '${input.runId}' is not waiting on human input.`);
    });
  }

  async #replyToHumanReviewGate(input: ReplyToRunInput & { readonly run: Run }): Promise<ReplyToRunResult> {
    if (input.request.kind === 'guidance') {
      throw new OrchestratorError('invalid_transition', `Guidance replies are only supported at implementation.awaiting_input.`);
    }
    if (this.#feedbackLifecycleDependencies === undefined) {
      throw new OrchestratorError('persistence_failed', 'Feedback lifecycle dependencies required for human review replies.');
    }

    const target = getHumanReviewGateFeedbackTarget(input.run.currentStep);

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
      const moved = await this.applyDirective({ runId: input.runId, tenant: input.tenant, directive: 'revise', origin: 'human', principal: input.principal });
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

    const moved = await this.applyDirective({ runId: input.runId, tenant: input.tenant, directive: 'advance', origin: 'human', principal: input.principal });
    return { ...moved, classification: { directive: 'advance', target } };
  }

  async #replyToAwaitingInput(input: ReplyToRunInput & { readonly run: Run }): Promise<ReplyToRunResult> {
    if (input.request.kind !== 'guidance') {
      throw new OrchestratorError('invalid_transition', 'Only guidance replies are supported at implementation.awaiting_input.');
    }
    if (this.#runSteps === undefined) {
      throw new OrchestratorError('persistence_failed', 'Run step repository required for awaiting-input replies.');
    }
    let pause: { runStep: RunStep };
    try {
      pause = await getConvergenceEscalationPause(
        { run: input.run, expectedStepId: 'implementation.awaiting_input' },
        { runSteps: this.#runSteps }
      );
      await recordConvergenceEscalationGuidance(
        { run: input.run, runStep: pause.runStep, guidance: input.request.body },
        { runSteps: this.#runSteps }
      );
    } catch (error) {
      if (error instanceof ConvergenceCheckpointError && error.code === 'invalid_pause') {
        throw new OrchestratorError('invalid_transition', 'Unsupported awaiting-input pause.', { details: { code: 'unsupported_pause' }, cause: error });
      }
      throw error;
    }
    // Advance WITHOUT passing checkpointResult — the guidance is already stored on the awaiting_input step
    const moved = await this.applyDirective({
      runId: input.runId,
      tenant: input.tenant,
      directive: 'advance',
      origin: 'human',
      principal: input.principal
    });
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

  #scheduleAutoDispatch(run: Run): void {
    if (!this.#autoDispatchEnabled) return;
    if (!this.#shouldAutoDispatch(run)) return;
    if (this.#autoDispatchInFlightRunIds.has(run.id)) return;

    this.#autoDispatchInFlightRunIds.add(run.id);
    // Capture result outside the .then so .finally can reschedule after releasing the marker.
    // Previously the marker was deleted in .then (before rescheduling) and again in .finally,
    // which clobbered the marker the reschedule had just added — letting a second concurrent
    // chain start. Now the marker is released exactly once, in .finally, then rescheduling runs.
    let dispatchResult: OrchestratedRunResult | undefined;
    void Promise.resolve()
      .then(async () => {
        dispatchResult = await this.dispatch({ runId: run.id, tenant: run.tenant });
      })
      .catch((error: unknown) => this.#handleAutoDispatchFailure(run, error))
      .finally(() => {
        this.#autoDispatchInFlightRunIds.delete(run.id);
        if (dispatchResult !== undefined && dispatchResult.run.currentStep !== run.currentStep) {
          this.#scheduleAutoDispatch(dispatchResult.run);
        }
      });
  }

  async #handleAutoDispatchFailure(run: Run, error: unknown): Promise<void> {
    const code = error instanceof OrchestratorError ? error.code : 'unexpected_error';
    this.#logger?.warn('Auto-dispatch failed after a committed run transition.', {
      runId: run.id,
      tenant: run.tenant,
      currentStep: run.currentStep,
      code,
      errorName: error instanceof Error ? error.name : typeof error
    });

    if (this.#isExpectedAutoDispatchFailure(error)) {
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
      await this.applyDirective({ runId: run.id, tenant: run.tenant, directive: 'fail', reason: publicReason });
    } catch (failError) {
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

  async #runSpecAuthoringCompletion(
    runId: string,
    run: Run,
    result: Readonly<Record<string, unknown>> | undefined
  ): Promise<{ kind: 'ok'; checkpointResult: CompleteSpecAuthoringOutput['checkpointResult'] } | { kind: 'failed' }> {
    if (this.#specAuthoringDependencies === undefined || this.#resolveWorkspaceContext === undefined) {
      this.#logger?.warn('spec.author advanced but specAuthoringDependencies or resolveWorkspaceContext not configured.', { runId });
      return { kind: 'failed' };
    }

    let workspaceContext: WorkspaceContext;
    try {
      workspaceContext = await this.#resolveWorkspaceContext({ runId });
    } catch (cause) {
      this.#logger?.warn('Failed to resolve workspace context for spec.author completion.', { runId, ...this.#safeCause(cause) });
      return { kind: 'failed' };
    }

    try {
      const output = await completeSpecAuthoring(
        {
          run,
          result: result as unknown as SpecAuthorResult,
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

      return { kind: 'ok', checkpointResult: output.checkpointResult };
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
      case 'unknown_workflow':
      case 'start_persistence_failed':
      case 'transition_persistence_failed':
        return new OrchestratorError('persistence_failed', error.message, { cause: error });
      default:
        return new OrchestratorError('persistence_failed', error.message, { cause: error });
    }
  }
}
