import type { Run, RunStep } from '@autocatalyst/api-contract';

/** Previously reached steps, in first-reached order. The server validates path and direction. */
export function runStepCandidates(run: Run, steps: readonly RunStep[] | undefined): string[] {
  if (steps === undefined) return [];
  return [...new Set([...steps].sort((a, b) => a.occurrence.index - b.occurrence.index)
    .filter(step => step.phase !== null && step.step !== run.currentStep)
    .map(step => step.step))];
}
