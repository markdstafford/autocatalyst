import type { RunStepId } from './run-step-catalog.js';
import type { RunWorkflowDefinition } from './run-workflows.js';

export const defaultConvergenceMaxRounds = 3 as const;

export interface StepConvergencePolicy {
  readonly maxRounds?: number;
}

export function getStepConvergencePolicy(workflow: RunWorkflowDefinition, step: RunStepId): Required<StepConvergencePolicy> {
  const configured = (workflow as { convergence?: Record<string, StepConvergencePolicy> }).convergence?.[step]?.maxRounds;
  return { maxRounds: configured ?? defaultConvergenceMaxRounds };
}
