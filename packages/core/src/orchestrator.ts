import type {
  ChannelReference,
  Conversation,
  JsonValue,
  Message,
  NonModelPrincipal,
  Run,
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

import type {
  ConversationIngressRepository,
  CreateConversationTopicMessageAndRunResult,
  LifecycleRunStepInput,
  RunRepository,
  RunWorkspaceMetadataRepository
} from './domain-repositories.js';
import type { FeedbackLifecycleDependencies } from './feedback-lifecycle.js';
import { listBlockingFeedback, resolveApproverAddressedFeedback } from './feedback-lifecycle.js';
import { assertSpecReviewGateCanAdvance, SpecReviewGateBlockedError } from './spec-review-gate.js';
import { type RunDispatchQueue } from './run-dispatch-queue.js';
import { createRunStateTransitionEvent, type RunEventStore } from './run-events.js';
import {
  applyRunDirective,
  buildEntryRunStep,
  RunLifecycleError,
  startRunLifecycle,
  type RunLifecycleState
} from './run-lifecycle.js';
import { deriveRunTerminal, getRunStepDefinition } from './run-step-catalog.js';
import { getRunWorkflowForWorkKind, type RunDirective } from './run-workflows.js';

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

// --- Orchestrator interface ---

export interface Orchestrator {
  createRun(input: CreateOrchestratedRunInput): Promise<OrchestratedRunResult>;
  createConversationWithFirstRun(input: CreateOrchestratedConversationInput): Promise<OrchestratedConversationResult>;
  applyDirective(input: ApplyOrchestratedDirectiveInput): Promise<OrchestratedRunResult>;
  dispatch(input: DispatchRunInput): Promise<OrchestratedRunResult>;
  tick(input: TickInput): Promise<TickResult>;
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

    // Defense-in-depth: block any advance directive when the run is already at a human gate,
    // unless it is spec.human_review (which has its own gate-check block below).
    // A stale concurrent dispatch can reach applyDirective after the run has moved to a human
    // step; this guard prevents it from leapfrogging the gate.
    if (input.directive === 'advance' && existing.currentStep !== 'spec.human_review') {
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
          this.#logger?.warn('Failed to resolve workspace context for spec approval finalization.', { runId: input.runId, cause });
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
          this.#logger?.warn('Spec approval finalization failed.', { runId: input.runId, cause });
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

    if (this.#unitOfWork === undefined) {
      throw new OrchestratorError('persistence_failed', 'No unit of work configured.');
    }
    const unitOfWork = this.#unitOfWork;

    return this.#dispatchQueue.enqueue(async () => {
      const result = await unitOfWork.run({ runId: input.runId, run, tenant: input.tenant });
      if (result.directive === 'fail') {
        return this.applyDirective({ runId: input.runId, directive: 'fail', tenant: input.tenant, reason: result.reason });
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
          return this.applyDirective({ runId: input.runId, directive: 'fail', tenant: input.tenant, reason: 'spec_authoring_failed' });
        }
        return this.applyDirective({
          runId: input.runId,
          directive: 'advance',
          tenant: input.tenant,
          checkpointResult: completionResult.checkpointResult as JsonValue
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
        ...(checkpointResult !== undefined ? { checkpointResult } : {})
      });
    });
  }

  async tick(input: TickInput): Promise<TickResult> {
    if (input.runId === undefined) {
      return { status: 'noop' };
    }
    await this.dispatch({ runId: input.runId, tenant: input.tenant });
    return { status: 'dispatched', runId: input.runId };
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
        // Only chain to the next step when the run actually advanced. A dispatch that leaves
        // the run on the same step must not reschedule, or auto-dispatch would spin.
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
      message: this.#safeFailureMessage(error)
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

    try {
      await this.applyDirective({ runId: run.id, tenant: run.tenant, directive: 'fail', reason: 'auto_dispatch_failed' });
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
      this.#logger?.warn('Failed to resolve workspace context for spec.author completion.', { runId, cause });
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
          this.#logger?.warn('Failed to persist workspace metadata for run; failing spec.author completion.', { runId, cause: persistCause });
          return { kind: 'failed' };
        }
      }

      return { kind: 'ok', checkpointResult: output.checkpointResult };
    } catch (cause) {
      this.#logger?.warn('spec.author completion service failed.', { runId, cause });
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
      this.#logger?.warn('Failed to append run state transition event after commit.', { error, runId: args.runId });
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
