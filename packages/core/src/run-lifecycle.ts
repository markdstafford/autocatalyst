import type { CreateRunInput, NonModelPrincipal, Run, RunStep, TestingGuideResult, TrackedIssue } from '@autocatalyst/api-contract';

import type { RunRepository } from './domain-repositories.js';
import { deriveRunTerminal, getRunStepDefinition, type RunStepDefinition } from './run-step-catalog.js';
import { nextWorkflowStep, type TransitionErrorCode, type TransitionResult } from './run-transition.js';
import { getRunWorkflowForWorkKind, type RunDirective, type RunWorkflowDefinition } from './run-workflows.js';

export type RunLifecycleErrorCode =
  | 'unknown_work_kind'
  | 'unknown_workflow'
  | 'missing_run'
  | 'terminal_run'
  | 'invalid_transition'
  | 'start_persistence_failed'
  | 'transition_persistence_failed';

export class RunLifecycleError extends Error {
  readonly code: RunLifecycleErrorCode;
  readonly transitionCode?: TransitionErrorCode;
  override readonly cause?: unknown;

  constructor(code: RunLifecycleErrorCode, message: string, options: { transitionCode?: TransitionErrorCode; cause?: unknown } = {}) {
    super(message);
    this.name = 'RunLifecycleError';
    this.code = code;
    this.transitionCode = options.transitionCode;
    this.cause = options.cause;
  }
}

export interface StartRunLifecycleInput {
  readonly runs: RunRepository;
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
  readonly runId: string;
  readonly directive: RunDirective;
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

function entryRunStep(step: RunStepDefinition, startedAt: string) {
  return { phase: step.phase, step: step.id, role: 'none', startedAt, endedAt: null, durationMs: null } as const;
}

function requireWorkflowForWorkKind(workKind: string): RunWorkflowDefinition {
  const workflow = getRunWorkflowForWorkKind(workKind);
  if (workflow === null) {
    throw new RunLifecycleError('unknown_work_kind', `Unknown work kind '${workKind}'.`);
  }
  return workflow;
}

export async function startRunLifecycle(input: StartRunLifecycleInput): Promise<RunLifecycleState> {
  const workflow = requireWorkflowForWorkKind(input.run.workKind);
  const firstStep = workflow.steps[0];
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
    const recorded = await input.runs.recordRunLifecycleStart({ run, runStep: entryRunStep(step, now(input.clock)) });
    return { run: recorded.run, workflow, step, runStep: recorded.runStep };
  } catch (error) {
    if (error instanceof RunLifecycleError) {
      throw error;
    }
    throw new RunLifecycleError('start_persistence_failed', 'Failed to record run lifecycle start.', { cause: error });
  }
}

export async function applyRunDirective(input: ApplyRunDirectiveInput): Promise<RunLifecycleState> {
  const existing = await input.runs.findById(input.runId);
  if (existing === null) {
    throw new RunLifecycleError('missing_run', `Run '${input.runId}' does not exist.`);
  }
  if (existing.terminal) {
    throw new RunLifecycleError('terminal_run', `Run '${input.runId}' is terminal.`);
  }
  const workflow = requireWorkflowForWorkKind(existing.workKind);
  const transition = nextWorkflowStep(workflow, existing.currentStep, input.directive);
  if (!transition.ok) {
    throw new RunLifecycleError('invalid_transition', transition.message, { transitionCode: transition.code });
  }
  const step = getRunStepDefinition(transition.to);
  if (step === null) {
    throw new RunLifecycleError('unknown_workflow', `Transition destination '${transition.to}' is not a known step.`);
  }
  try {
    const recorded = await input.runs.recordRunStepTransition({
      runId: existing.id,
      currentStep: step.id,
      terminal: deriveRunTerminal(step.id),
      runStep: entryRunStep(step, now(input.clock))
    });
    return { run: recorded.run, workflow, step, runStep: recorded.runStep, transition };
  } catch (error) {
    if (error instanceof RunLifecycleError) {
      throw error;
    }
    throw new RunLifecycleError('transition_persistence_failed', 'Failed to record run lifecycle transition.', { cause: error });
  }
}
