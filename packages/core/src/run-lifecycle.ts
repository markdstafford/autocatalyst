import type { CreateRunInput, JsonValue, NonModelPrincipal, Run, RunStep, TestingGuideResult, TrackedIssue } from '@autocatalyst/api-contract';

import { RunTransitionConflictError, type LifecycleRunStepInput, type RunRepository } from './domain-repositories.js';
import { deriveRunTerminal, getRunStepDefinition, type RunStepDefinition } from './run-step-catalog.js';
import { nextWorkflowStep, type TransitionErrorCode, type TransitionResult } from './run-transition.js';
import type { RunDirective, RunWorkflowDefinition } from './run-workflows.js';
import { requestedWorkflowWorkKind, resolveRunWorkflow, type RunWorkflowResolver, type RunWorkflowResolverInput } from './run-workflow-resolver.js';

export type RunLifecycleErrorCode =
  | 'unknown_work_kind'
  | 'unknown_workflow'
  | 'missing_run'
  | 'terminal_run'
  | 'invalid_transition'
  | 'start_persistence_failed'
  | 'source_step_mismatch'
  | 'source_occurrence_mismatch'
  | 'transition_persistence_failed';

export class RunLifecycleError extends Error {
  readonly code: RunLifecycleErrorCode;
  readonly transitionCode?: TransitionErrorCode;
  override readonly cause?: unknown;

  constructor(code: RunLifecycleErrorCode, message: string, options: { transitionCode?: TransitionErrorCode; cause?: unknown } = {}) {
    super(message);
    this.name = 'RunLifecycleError';
    this.code = code;
    if (options.transitionCode !== undefined) {
      this.transitionCode = options.transitionCode;
    }
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export interface StartRunLifecycleInput {
  readonly runs: RunRepository;
  readonly workflowResolver?: RunWorkflowResolver;
  readonly run: {
    readonly topicId: string;
    readonly owner: NonModelPrincipal;
    readonly tenant: string;
    readonly workKind: string;
    readonly trackedIssue?: TrackedIssue;
    readonly testingGuideResult?: TestingGuideResult;
  };
  readonly clock?: () => string;
}

export interface ApplyRunDirectiveInput {
  readonly runs: RunRepository;
  readonly workflowResolver?: RunWorkflowResolver;
  readonly runId: string;
  readonly directive: RunDirective;
  readonly source?: Run;
  readonly sourceRunStepId?: string;
  readonly checkpointResult?: JsonValue;
  readonly destinationCheckpointResult?: JsonValue;
  readonly reason?: string;
  readonly clock?: () => string;
}

export interface RunLifecycleState {
  readonly run: Run;
  readonly workflow: RunWorkflowDefinition;
  readonly step: RunStepDefinition;
  readonly runStep: RunStep;
  readonly transition?: Extract<TransitionResult, { ok: true }>;
}

function now(clock?: () => string): string {
  return clock?.() ?? new Date().toISOString();
}

export function buildEntryRunStep(step: RunStepDefinition, startedAt: string): LifecycleRunStepInput {
  return { phase: step.phase, step: step.id, role: 'none', startedAt, endedAt: null, durationMs: null };
}

export async function requireRunWorkflow(
  input: RunWorkflowResolverInput,
  resolver?: RunWorkflowResolver
): Promise<RunWorkflowDefinition> {
  let checked;
  try {
    checked = await resolveRunWorkflow(input, resolver);
  } catch (cause) {
    throw new RunLifecycleError('unknown_workflow', 'Failed to resolve run workflow.', { cause });
  }
  if (checked === null) {
    throw new RunLifecycleError('unknown_work_kind', `Unknown work kind '${requestedWorkflowWorkKind(input)}'.`);
  }
  return checked.definition;
}

export async function startRunLifecycle(input: StartRunLifecycleInput): Promise<RunLifecycleState> {
  const { topicId, tenant, workKind } = input.run;
  const workflow = await requireRunWorkflow({ kind: 'existing_topic', topicId, tenant, workKind }, input.workflowResolver);
  const firstStep = workflow.steps[0] as string | undefined;
  if (firstStep === undefined) {
    throw new RunLifecycleError('unknown_workflow', `Workflow '${workflow.id}' has no steps.`);
  }
  const step = getRunStepDefinition(firstStep);
  if (step === null) {
    throw new RunLifecycleError('unknown_workflow', `Workflow '${workflow.id}' starts with unknown step '${firstStep}'.`);
  }
  const run: CreateRunInput = {
    topicId: input.run.topicId,
    owner: input.run.owner,
    tenant: input.run.tenant,
    workKind: input.run.workKind,
    currentStep: step.id,
    terminal: deriveRunTerminal(step.id),
    ...(input.run.trackedIssue === undefined ? {} : { trackedIssue: input.run.trackedIssue }),
    ...(input.run.testingGuideResult === undefined ? {} : { testingGuideResult: input.run.testingGuideResult })
  };
  try {
    const recorded = await input.runs.recordRunLifecycleStart({ run, runStep: buildEntryRunStep(step, now(input.clock)) });
    return { run: recorded.run, workflow, step, runStep: recorded.runStep };
  } catch (error) {
    if (error instanceof RunLifecycleError) {
      throw error;
    }
    throw new RunLifecycleError('start_persistence_failed', 'Failed to record run lifecycle start.', { cause: error });
  }
}

export async function applyRunDirective(input: ApplyRunDirectiveInput): Promise<RunLifecycleState> {
  const existing = input.source ?? await input.runs.findById(input.runId);
  if (existing === null) {
    throw new RunLifecycleError('missing_run', `Run '${input.runId}' does not exist.`);
  }
  if (existing.terminal) {
    throw new RunLifecycleError('terminal_run', `Run '${input.runId}' is terminal.`);
  }
  const workflow = await requireRunWorkflow({ kind: 'existing_run', run: existing }, input.workflowResolver);
  const transition = nextWorkflowStep(workflow, existing.currentStep, input.directive);
  if (!transition.ok) {
    throw new RunLifecycleError('invalid_transition', transition.message, { transitionCode: transition.code });
  }
  const step = getRunStepDefinition(transition.to);
  if (step === null) {
    throw new RunLifecycleError('unknown_workflow', `Transition destination '${transition.to}' is not a known step.`);
  }
  try {
    const sourceRunStep = input.sourceRunStepId === undefined && input.runs.findLatestOpenRunStep
      ? await input.runs.findLatestOpenRunStep({ runId: existing.id, step: existing.currentStep })
      : null;
    const recorded = await input.runs.recordRunStepTransition({
      runId: existing.id,
      expectedStep: existing.currentStep,
      currentStep: step.id,
      terminal: deriveRunTerminal(step.id),
      runStep: buildEntryRunStep(step, now(input.clock)),
      ...(input.sourceRunStepId !== undefined ? { sourceRunStepId: input.sourceRunStepId }
        : sourceRunStep !== null ? { sourceRunStepId: sourceRunStep.id } : {}),
      ...(input.checkpointResult !== undefined ? { checkpointResult: input.checkpointResult } : {}),
      ...(input.destinationCheckpointResult !== undefined ? { destinationCheckpointResult: input.destinationCheckpointResult } : {}),
      ...(input.directive === 'fail' && input.reason !== undefined ? { failureReason: input.reason } : {})
    });
    return { run: recorded.run, workflow, step, runStep: recorded.runStep, transition };
  } catch (error) {
    if (error instanceof RunLifecycleError) {
      throw error;
    }
    if (error instanceof RunTransitionConflictError) throw new RunLifecycleError(error.code, error.message, { cause: error });
    throw new RunLifecycleError('transition_persistence_failed', 'Failed to record run lifecycle transition.', { cause: error });
  }
}
