import type { JsonValue, Run, RunStep } from '@autocatalyst/api-contract';
import type { RunStepRepository } from './domain-repositories.js';

export interface ConvergenceEscalationPauseCheckpoint {
  readonly pause: {
    readonly kind: 'convergence_escalation';
    readonly producingStep: 'implementation.build';
    readonly humanGuidance?: string;
  };
}

export type ConvergenceCheckpointErrorCode = 'invalid_pause' | 'changed_step' | 'persistence_failed';

export class ConvergenceCheckpointError extends Error {
  readonly code: ConvergenceCheckpointErrorCode;
  constructor(code: ConvergenceCheckpointErrorCode, message: string) {
    super(message);
    this.name = 'ConvergenceCheckpointError';
    this.code = code;
  }
}

function asCheckpoint(value: JsonValue | null): ConvergenceEscalationPauseCheckpoint | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const pause = obj['pause'];
  if (pause === null || typeof pause !== 'object' || Array.isArray(pause)) return null;
  const pauseObj = pause as Record<string, unknown>;
  if (pauseObj['kind'] !== 'convergence_escalation') return null;
  if (pauseObj['producingStep'] !== 'implementation.build') return null;
  return value as unknown as ConvergenceEscalationPauseCheckpoint;
}

export async function getConvergenceEscalationPause(
  input: { readonly run: Run; readonly expectedStepId: 'implementation.awaiting_input' },
  deps: { readonly runSteps: RunStepRepository }
): Promise<{ readonly runStep: RunStep; readonly checkpoint: ConvergenceEscalationPauseCheckpoint }> {
  if (input.run.currentStep !== input.expectedStepId) {
    throw new ConvergenceCheckpointError('changed_step', 'Run is no longer at implementation.awaiting_input.');
  }
  const steps = await deps.runSteps.listByRun(input.run.id);
  const runStep =
    [...steps].reverse().find(step => step.step === input.expectedStepId && step.endedAt === null) ??
    [...steps].reverse().find(step => step.step === input.expectedStepId);
  if (runStep === undefined) {
    throw new ConvergenceCheckpointError('changed_step', 'Current awaiting-input run step was not found.');
  }
  const checkpoint = asCheckpoint(runStep.checkpointResult);
  if (checkpoint === null) {
    throw new ConvergenceCheckpointError('invalid_pause', 'Awaiting-input pause is not a supported convergence escalation.');
  }
  return { runStep, checkpoint };
}

export async function recordConvergenceEscalationGuidance(
  input: { readonly run: Run; readonly runStep: RunStep; readonly guidance: string },
  deps: { readonly runSteps: RunStepRepository }
): Promise<RunStep> {
  if (input.run.currentStep !== 'implementation.awaiting_input' || input.runStep.step !== 'implementation.awaiting_input') {
    throw new ConvergenceCheckpointError('changed_step', 'Run step changed before guidance could be recorded.');
  }
  const existing = asCheckpoint(input.runStep.checkpointResult);
  if (existing === null) {
    throw new ConvergenceCheckpointError('invalid_pause', 'Awaiting-input pause is not a supported convergence escalation.');
  }
  return deps.runSteps.updateCheckpoint({
    runStepId: input.runStep.id,
    runId: input.run.id,
    tenant: input.run.tenant,
    checkpointResult: { pause: { ...existing.pause, humanGuidance: input.guidance } }
  });
}
