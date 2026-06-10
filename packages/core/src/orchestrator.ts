import type {
  ChannelReference,
  Conversation,
  Message,
  NonModelPrincipal,
  Run,
  RunStateTransitionKind,
  RunStep,
  TestingGuideResult,
  Topic,
  TrackedIssue
} from '@autocatalyst/api-contract';

import type {
  ConversationIngressRepository,
  CreateConversationTopicMessageAndRunResult,
  LifecycleRunStepInput,
  RunRepository
} from './domain-repositories.js';
import { type RunDispatchQueue } from './run-dispatch-queue.js';
import { createRunStateTransitionEvent, type RunEventPublisher } from './run-events.js';
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

// --- Constructor options ---

export interface DefaultOrchestratorOptions {
  readonly runs: RunRepository;
  readonly conversationIngress: ConversationIngressRepository;
  readonly events: RunEventPublisher;
  readonly dispatchQueue: RunDispatchQueue;
  readonly unitOfWork?: RunUnitOfWork;
  readonly clock?: () => string;
  readonly eventIdGenerator?: () => string;
  readonly isActiveRunConflict?: (error: unknown) => boolean;
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
  readonly #events: RunEventPublisher;
  readonly #dispatchQueue: RunDispatchQueue;
  readonly #unitOfWork: RunUnitOfWork | undefined;
  readonly #clock: (() => string) | undefined;
  readonly #eventIdGenerator: (() => string) | undefined;
  readonly #isActiveRunConflict: (error: unknown) => boolean;

  constructor(options: DefaultOrchestratorOptions) {
    this.#runs = options.runs;
    this.#conversationIngress = options.conversationIngress;
    this.#events = options.events;
    this.#dispatchQueue = options.dispatchQueue;
    this.#unitOfWork = options.unitOfWork;
    this.#clock = options.clock;
    this.#eventIdGenerator = options.eventIdGenerator;
    this.#isActiveRunConflict = options.isActiveRunConflict ?? defaultIsActiveRunConflict;
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

    this.#publishEvent({
      runId: state.run.id,
      directive: 'start',
      toStep: state.run.currentStep,
      run: state.run,
      runStep: state.runStep,
      tenant: state.run.tenant
    });

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

    this.#publishEvent({
      runId: result.run.id,
      directive: 'start',
      toStep: result.run.currentStep,
      run: result.run,
      runStep: result.runStep,
      tenant: result.run.tenant
    });

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

    let state: RunLifecycleState;
    try {
      state = await applyRunDirective({
        runs: this.#runs,
        runId: input.runId,
        directive: input.directive,
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

    this.#publishEvent({
      runId: state.run.id,
      directive: input.directive as RunStateTransitionKind,
      fromStep,
      toStep: state.run.currentStep,
      run: state.run,
      runStep: state.runStep,
      tenant: state.run.tenant
    });

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

    if (this.#unitOfWork === undefined) {
      throw new OrchestratorError('persistence_failed', 'No unit of work configured.');
    }
    const unitOfWork = this.#unitOfWork;

    return this.#dispatchQueue.enqueue(async () => {
      const result = await unitOfWork.run({ runId: input.runId, run, tenant: input.tenant });
      if (result.directive === 'fail') {
        return this.applyDirective({ runId: input.runId, directive: 'fail', tenant: input.tenant });
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
        // result.question is available for future storage; not persisted in this implementation
      }
      const directive: RunDirective = result.directive === 'needs_input' ? 'needs_input' : 'advance';
      return this.applyDirective({ runId: input.runId, directive, tenant: input.tenant });
    });
  }

  async tick(input: TickInput): Promise<TickResult> {
    if (input.runId === undefined) {
      return { status: 'noop' };
    }
    await this.dispatch({ runId: input.runId, tenant: input.tenant });
    return { status: 'dispatched', runId: input.runId };
  }

  #publishEvent(args: {
    runId: string;
    directive: RunStateTransitionKind;
    fromStep?: string;
    toStep: string;
    run: Run;
    runStep: RunStep;
    tenant: string;
  }): void {
    const event = createRunStateTransitionEvent({
      runId: args.runId,
      directive: args.directive,
      ...(args.fromStep !== undefined ? { fromStep: args.fromStep } : {}),
      toStep: args.toStep,
      run: args.run,
      runStep: args.runStep,
      tenant: args.tenant,
      ...(this.#eventIdGenerator !== undefined ? { idGenerator: this.#eventIdGenerator } : {}),
      ...(this.#clock !== undefined ? { clock: this.#clock } : {})
    });
    this.#events.publish(event);
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
