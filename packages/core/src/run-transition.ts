import { getRunStepDefinition, isKnownRunStepId, runStepCatalog, type RunPhase, type RunStepId } from './run-step-catalog.js';
import { isKnownRunWorkflowId, type RunDirective, type RunWorkflowDefinition, type RunWorkflowId } from './run-workflows.js';

export type TransitionErrorCode =
  | 'unknown_workflow'
  | 'unknown_step'
  | 'step_not_in_workflow'
  | 'terminal_step'
  | 'invalid_directive'
  | 'missing_edge'
  | 'missing_pause_target';

export type TransitionResult =
  | { ok: true; workflowId: RunWorkflowId; from: RunStepId; directive: RunDirective; to: RunStepId }
  | { ok: false; code: TransitionErrorCode; message: string };

const supportedDirectives = new Set<string>(['advance', 'revise', 'needs_input', 'cancel', 'fail']);

function transitionFailure(code: TransitionErrorCode, message: string): TransitionResult {
  return { ok: false, code, message };
}

function hasPhaseLocalPauseTarget(phase: RunPhase, ownedSteps: ReadonlySet<RunStepId>): boolean {
  if (phase === null) return false;
  const pauseId = `${phase}.awaiting_input`;
  return isKnownRunStepId(pauseId) && ownedSteps.has(pauseId);
}

function workflowOwnedSteps(workflow: RunWorkflowDefinition): ReadonlySet<RunStepId> {
  const owned = new Set<RunStepId>(workflow.steps);
  for (const [source, directives] of Object.entries(workflow.transitions)) {
    if (isKnownRunStepId(source)) {
      owned.add(source);
    }
    if (directives !== undefined) {
      for (const destination of Object.values(directives)) {
        if (destination !== undefined) {
          owned.add(destination);
        }
      }
    }
  }
  return owned;
}

export function nextWorkflowStep(workflow: RunWorkflowDefinition, currentStep: string, directive: RunDirective): TransitionResult {
  if (!isKnownRunWorkflowId(workflow.id)) {
    return transitionFailure('unknown_workflow', `Unknown workflow '${workflow.id}'.`);
  }
  if (!isKnownRunStepId(currentStep)) {
    return transitionFailure('unknown_step', `Unknown run step '${currentStep}'.`);
  }
  if (!supportedDirectives.has(directive)) {
    return transitionFailure('invalid_directive', `Unsupported run directive '${String(directive)}'.`);
  }

  const ownedSteps = workflowOwnedSteps(workflow);
  if (!ownedSteps.has(currentStep)) {
    return transitionFailure('step_not_in_workflow', `Step '${currentStep}' is not part of workflow '${workflow.id}'.`);
  }

  const currentDefinition = getRunStepDefinition(currentStep);
  if (currentDefinition === null) {
    return transitionFailure('unknown_step', `Unknown run step '${currentStep}'.`);
  }
  if (currentDefinition.waitingOn === 'none') {
    return transitionFailure('terminal_step', `Step '${currentStep}' is terminal.`);
  }

  if (directive === 'cancel') {
    return { ok: true, workflowId: workflow.id, from: currentStep, directive, to: 'canceled' };
  }
  if (directive === 'fail') {
    return { ok: true, workflowId: workflow.id, from: currentStep, directive, to: 'failed' };
  }

  const nextStep = workflow.transitions[currentStep]?.[directive];
  if (nextStep === undefined) {
    if (directive === 'needs_input') {
      const currentPhase = runStepCatalog[currentStep].phase;
      const code = hasPhaseLocalPauseTarget(currentPhase, ownedSteps) ? 'missing_edge' : 'missing_pause_target';
      return transitionFailure(code, `Workflow '${workflow.id}' has no '${directive}' edge from '${currentStep}'.`);
    }
    return transitionFailure('missing_edge', `Workflow '${workflow.id}' has no '${directive}' edge from '${currentStep}'.`);
  }
  if (!isKnownRunStepId(nextStep)) {
    return transitionFailure('unknown_step', `Transition destination '${nextStep}' is not a known step.`);
  }
  if (!ownedSteps.has(nextStep) && runStepCatalog[nextStep].waitingOn !== 'none') {
    return transitionFailure('step_not_in_workflow', `Transition destination '${nextStep}' is not part of workflow '${workflow.id}'.`);
  }

  return { ok: true, workflowId: workflow.id, from: currentStep, directive, to: nextStep };
}
