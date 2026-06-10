import type {
  CreateConversationWithFirstRunRequest,
  CreateConversationWithFirstRunResponse,
  NonModelPrincipal,
  Principal,
  Run,
  RunStep
} from '@autocatalyst/api-contract';
import { createConversationWithFirstRunResponseSchema } from '@autocatalyst/api-contract';

import type { RunRepository, RunStepRepository } from './domain-repositories.js';
import {
  OrchestratorError,
  type OrchestratedConversationResult,
  type Orchestrator,
  type OrchestratorErrorCode
} from './orchestrator.js';
import type { PolicyDecisionPoint, PolicyResourceDescriptor } from './policy.js';
import type { RunEventStore, RunEventSubscription } from './run-events.js';
import type { RunEventReplayResult } from '@autocatalyst/api-contract';

// --- Error types ---

export type ControlPlaneServiceErrorCode =
  | 'not_found'
  | 'forbidden'
  | 'intake_routing_error'
  | 'active_run_conflict'
  | 'persistence_failed'
  | 'unauthorized';

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
}

export interface ServiceTickInput {
  readonly principal: Principal;
  readonly tenant: string;
  readonly runId?: string;
}

export type ServiceTickResult =
  | { readonly status: 'noop' }
  | { readonly status: 'dispatched'; readonly runId: string };

// --- Service interface ---

export interface ControlPlaneService {
  createConversationWithFirstRun(
    input: ServiceCreateConversationInput
  ): Promise<CreateConversationWithFirstRunResponse>;
  getRun(input: ServiceGetRunInput): Promise<ServiceGetRunResult>;
  listRunSteps(input: ServiceListRunStepsInput): Promise<ServiceListRunStepsResult>;
  subscribeRunEvents(input: ServiceSubscribeRunEventsInput): Promise<RunEventSubscription>;
  replayRunEvents(input: ServiceReplayRunEventsInput): Promise<RunEventReplayResult>;
  tick(input: ServiceTickInput): Promise<ServiceTickResult>;
}

// --- Constructor options ---

export interface DefaultControlPlaneServiceOptions {
  readonly orchestrator: Orchestrator;
  readonly runs: RunRepository;
  readonly runSteps: RunStepRepository;
  readonly events: RunEventStore;
  readonly policy: PolicyDecisionPoint;
}

// --- Implementation ---

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

export class DefaultControlPlaneService implements ControlPlaneService {
  readonly #orchestrator: Orchestrator;
  readonly #runs: RunRepository;
  readonly #runSteps: RunStepRepository;
  readonly #events: RunEventStore;
  readonly #policy: PolicyDecisionPoint;

  constructor(options: DefaultControlPlaneServiceOptions) {
    this.#orchestrator = options.orchestrator;
    this.#runs = options.runs;
    this.#runSteps = options.runSteps;
    this.#events = options.events;
    this.#policy = options.policy;
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

    let result: OrchestratedConversationResult;
    try {
      result = await this.#orchestrator.createConversationWithFirstRun({
        projectId: request.projectId,
        owner: ownerPrincipal,
        tenant: input.tenant,
        identity: request.identity,
        ...(request.channel !== undefined ? { channel: request.channel } : {}),
        topic: { title: request.topic.title },
        ...(request.submission.body !== undefined
          ? { message: { body: request.submission.body } }
          : {}),
        workKind: request.submission.workKind,
        ...(request.submission.trackedIssue !== undefined
          ? { trackedIssue: request.submission.trackedIssue }
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

    return { run };
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
      ...(input.lastEventId !== undefined ? { lastEventId: input.lastEventId } : {})
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
}
