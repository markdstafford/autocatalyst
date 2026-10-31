import { describe, expect, it } from 'vitest';
import type { RunStep } from '@autocatalyst/api-contract';

import {
  findStoppedStep,
  phaseFirstStep,
  resolveRecoveryPlan,
  RecoveryPlanError
} from './run-recovery.js';

const ts = '2026-10-28T00:00:00.000Z';

function step(stepId: string, overrides?: Partial<RunStep>): RunStep {
  return {
    id: `step_${stepId}_${overrides?.occurrence?.index ?? 0}`,
    runId: 'run_1',
    phase: null,
    step: stepId,
    role: 'none',
    startedAt: ts,
    endedAt: ts,
    durationMs: 0,
    occurrence: { index: 0, attempt: 1 },
    checkpointResult: null,
    ...overrides
  };
}

describe('phaseFirstStep', () => {
  it('maps each phase to its entry step', () => {
    expect(phaseFirstStep('spec')).toBe('spec.author');
    expect(phaseFirstStep('implementation')).toBe('implementation.plan');
    expect(phaseFirstStep('docs')).toBe('docs.update');
    expect(phaseFirstStep('pr')).toBe('pr.finalize');
    expect(phaseFirstStep(null)).toBeNull();
  });
});

describe('findStoppedStep', () => {
  it('returns the latest non-terminal step before the failed row', () => {
    const steps = [
      step('intake', { occurrence: { index: 0, attempt: 1 } }),
      step('implementation.build', { occurrence: { index: 1, attempt: 1 } }),
      step('failed', { occurrence: { index: 2, attempt: 1 }, endedAt: null })
    ];
    expect(findStoppedStep(steps)?.step).toBe('implementation.build');
  });

  it('ignores the terminal failed row and repeated prior failures', () => {
    const steps = [
      step('spec.author', { occurrence: { index: 0, attempt: 1 } }),
      step('implementation.build', { occurrence: { index: 1, attempt: 1 } }),
      step('implementation.build', { occurrence: { index: 2, attempt: 2 } }),
      step('failed', { occurrence: { index: 3, attempt: 1 } })
    ];
    const stopped = findStoppedStep(steps);
    expect(stopped?.step).toBe('implementation.build');
    expect(stopped?.occurrence.attempt).toBe(2);
  });

  it('returns null when only terminal rows exist', () => {
    expect(findStoppedStep([step('failed')])).toBeNull();
    expect(findStoppedStep([])).toBeNull();
  });
});

describe('resolveRecoveryPlan', () => {
  it('omitted mode starts spec failures over at spec.author on the default branch', () => {
    const plan = resolveRecoveryPlan({ stoppedStep: step('spec.author'), hasCommittedCheckpoints: true });
    expect(plan).toEqual({ mode: 'start_over', reDispatchStep: 'spec.author', baseKind: 'current_default_branch', existingWorkspaceBehavior: 'replace' });
  });

  it('omitted mode resumes implementation failures with committed checkpoints at the failed step', () => {
    const plan = resolveRecoveryPlan({ stoppedStep: step('implementation.build'), hasCommittedCheckpoints: true });
    expect(plan).toEqual({ mode: 'resume', reDispatchStep: 'implementation.build', baseKind: 'run_branch', existingWorkspaceBehavior: 'keep' });
  });

  it('omitted mode resumes docs and pr failures with committed checkpoints', () => {
    expect(resolveRecoveryPlan({ stoppedStep: step('docs.update'), hasCommittedCheckpoints: true }).mode).toBe('resume');
    expect(resolveRecoveryPlan({ stoppedStep: step('pr.finalize'), hasCommittedCheckpoints: true }).mode).toBe('resume');
  });

  it('omitted mode starts pre-commit implementation failures over at the first phase step', () => {
    const plan = resolveRecoveryPlan({ stoppedStep: step('implementation.build'), hasCommittedCheckpoints: false });
    expect(plan).toEqual({ mode: 'start_over', reDispatchStep: 'implementation.plan', baseKind: 'current_default_branch', existingWorkspaceBehavior: 'replace' });
  });

  it('explicit resume uses the failed step and run branch for any phase', () => {
    const plan = resolveRecoveryPlan({ stoppedStep: step('spec.author'), explicitMode: 'resume', hasCommittedCheckpoints: false });
    expect(plan).toEqual({ mode: 'resume', reDispatchStep: 'spec.author', baseKind: 'run_branch', existingWorkspaceBehavior: 'keep' });
  });

  it('explicit start_over uses spec.author for spec and the first phase step otherwise', () => {
    expect(resolveRecoveryPlan({ stoppedStep: step('spec.author'), explicitMode: 'start_over', hasCommittedCheckpoints: true }).reDispatchStep).toBe('spec.author');
    expect(resolveRecoveryPlan({ stoppedStep: step('implementation.build'), explicitMode: 'start_over', hasCommittedCheckpoints: true }).reDispatchStep).toBe('implementation.plan');
    expect(resolveRecoveryPlan({ stoppedStep: step('docs.update'), explicitMode: 'start_over', hasCommittedCheckpoints: true }).reDispatchStep).toBe('docs.update');
  });

  it('throws for a stopped step with no recoverable phase', () => {
    expect(() => resolveRecoveryPlan({ stoppedStep: step('question.answer'), hasCommittedCheckpoints: false })).toThrow(RecoveryPlanError);
  });
});
