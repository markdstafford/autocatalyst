import { describe, expect, it, vi } from 'vitest';
import type { Run, RunStep } from '@autocatalyst/api-contract';
import type { RunStepRepository, UpdateRunStepCheckpointInput } from './domain-repositories.js';
import {
  getConvergenceEscalationPause,
  recordConvergenceEscalationGuidance
} from './convergence-checkpoint.js';

const timestamp = '2026-01-01T00:00:00.000Z';

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run_1',
    topicId: 'topic_1',
    owner: { id: 'user_1', kind: 'human', tenantId: 'tenant_1', displayName: 'Ada' },
    tenant: 'tenant_1',
    workKind: 'feature',
    currentStep: 'implementation.awaiting_input',
    terminal: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides
  };
}

function makeRunStep(overrides: Partial<RunStep> = {}): RunStep {
  return {
    id: 'step_1',
    runId: 'run_1',
    phase: 'implementation',
    step: 'implementation.awaiting_input',
    role: 'none',
    startedAt: timestamp,
    endedAt: null,
    durationMs: null,
    occurrence: { index: 0, attempt: 1 },
    checkpointResult: {
      pause: {
        kind: 'convergence_escalation',
        producingStep: 'implementation.build'
      }
    },
    ...overrides
  };
}

function makeRunStepDeps(steps: readonly RunStep[] = []): { runSteps: RunStepRepository; captured: UpdateRunStepCheckpointInput[] } {
  const captured: UpdateRunStepCheckpointInput[] = [];
  const stepStore = [...steps];
  const runSteps: RunStepRepository = {
    create: vi.fn(),
    findById: vi.fn().mockResolvedValue(null),
    listByRun: vi.fn().mockResolvedValue(stepStore),
    updateCheckpoint: vi.fn(async (input: UpdateRunStepCheckpointInput) => {
      captured.push(input);
      const existing = stepStore.find(s => s.id === input.runStepId);
      return {
        ...(existing ?? makeRunStep()),
        checkpointResult: input.checkpointResult
      };
    })
  };
  return { runSteps, captured };
}

describe('convergence checkpoint helpers', () => {
  describe('getConvergenceEscalationPause', () => {
    it('loads a current convergence escalation pause', async () => {
      const step = makeRunStep();
      const run = makeRun();
      const { runSteps } = makeRunStepDeps([step]);

      const result = await getConvergenceEscalationPause(
        { run, expectedStepId: 'implementation.awaiting_input' },
        { runSteps }
      );

      expect(result.runStep).toBe(step);
      expect(result.checkpoint.pause.kind).toBe('convergence_escalation');
      expect(result.checkpoint.pause.producingStep).toBe('implementation.build');
    });

    it('finds the most recent open step when multiple exist', async () => {
      const endedStep = makeRunStep({ id: 'step_ended', endedAt: timestamp });
      const openStep = makeRunStep({ id: 'step_open', endedAt: null });
      const run = makeRun();
      const { runSteps } = makeRunStepDeps([endedStep, openStep]);

      const result = await getConvergenceEscalationPause(
        { run, expectedStepId: 'implementation.awaiting_input' },
        { runSteps }
      );

      expect(result.runStep.id).toBe('step_open');
    });

    it('falls back to any awaiting_input step when none is open', async () => {
      const step = makeRunStep({ id: 'step_ended', endedAt: timestamp });
      const run = makeRun();
      const { runSteps } = makeRunStepDeps([step]);

      const result = await getConvergenceEscalationPause(
        { run, expectedStepId: 'implementation.awaiting_input' },
        { runSteps }
      );

      expect(result.runStep.id).toBe('step_ended');
    });

    it('throws changed_step when run is no longer at implementation.awaiting_input', async () => {
      const run = makeRun({ currentStep: 'implementation.build' });
      const { runSteps } = makeRunStepDeps([makeRunStep()]);

      await expect(
        getConvergenceEscalationPause(
          { run, expectedStepId: 'implementation.awaiting_input' },
          { runSteps }
        )
      ).rejects.toMatchObject({ name: 'ConvergenceCheckpointError', code: 'changed_step' });
    });

    it('throws changed_step when no awaiting_input step is found', async () => {
      const run = makeRun();
      const { runSteps } = makeRunStepDeps([]); // no steps

      await expect(
        getConvergenceEscalationPause(
          { run, expectedStepId: 'implementation.awaiting_input' },
          { runSteps }
        )
      ).rejects.toMatchObject({ name: 'ConvergenceCheckpointError', code: 'changed_step' });
    });

    it('rejects non-convergence-escalation pauses as unsupported', async () => {
      const step = makeRunStep({
        checkpointResult: { pause: { kind: 'model_question', producingStep: 'implementation.build' } }
      });
      const run = makeRun();
      const { runSteps } = makeRunStepDeps([step]);

      await expect(
        getConvergenceEscalationPause(
          { run, expectedStepId: 'implementation.awaiting_input' },
          { runSteps }
        )
      ).rejects.toMatchObject({ name: 'ConvergenceCheckpointError', code: 'invalid_pause' });
    });

    it('rejects null checkpointResult as unsupported', async () => {
      const step = makeRunStep({ checkpointResult: null });
      const run = makeRun();
      const { runSteps } = makeRunStepDeps([step]);

      await expect(
        getConvergenceEscalationPause(
          { run, expectedStepId: 'implementation.awaiting_input' },
          { runSteps }
        )
      ).rejects.toMatchObject({ name: 'ConvergenceCheckpointError', code: 'invalid_pause' });
    });
  });

  describe('recordConvergenceEscalationGuidance', () => {
    it('records human guidance on the awaiting_input step checkpoint', async () => {
      const step = makeRunStep();
      const run = makeRun();
      const { runSteps, captured } = makeRunStepDeps([step]);

      await recordConvergenceEscalationGuidance(
        { run, runStep: step, guidance: 'Prefer public API; do not broaden auth.' },
        { runSteps }
      );

      expect(captured).toHaveLength(1);
      const call = captured[0]!;
      expect(call.runStepId).toBe('step_1');
      expect(call.runId).toBe('run_1');
      expect(call.tenant).toBe('tenant_1');
      const cp = call.checkpointResult as { pause: { kind: string; producingStep: string; humanGuidance: string } };
      expect(cp.pause.kind).toBe('convergence_escalation');
      expect(cp.pause.producingStep).toBe('implementation.build');
      expect(cp.pause.humanGuidance).toBe('Prefer public API; do not broaden auth.');
    });

    it('preserves existing pause fields when adding guidance', async () => {
      const step = makeRunStep({
        checkpointResult: {
          pause: {
            kind: 'convergence_escalation',
            producingStep: 'implementation.build'
          }
        }
      });
      const run = makeRun();
      const { runSteps, captured } = makeRunStepDeps([step]);

      await recordConvergenceEscalationGuidance(
        { run, runStep: step, guidance: 'Do it differently.' },
        { runSteps }
      );

      const cp = captured[0]!.checkpointResult as { pause: { kind: string; producingStep: string; humanGuidance: string } };
      expect(cp.pause.kind).toBe('convergence_escalation');
      expect(cp.pause.producingStep).toBe('implementation.build');
      expect(cp.pause.humanGuidance).toBe('Do it differently.');
    });

    it('throws changed_step when run is not at implementation.awaiting_input', async () => {
      const step = makeRunStep();
      const run = makeRun({ currentStep: 'implementation.build' });
      const { runSteps } = makeRunStepDeps([step]);

      await expect(
        recordConvergenceEscalationGuidance(
          { run, runStep: step, guidance: 'guidance' },
          { runSteps }
        )
      ).rejects.toMatchObject({ name: 'ConvergenceCheckpointError', code: 'changed_step' });
    });

    it('throws changed_step when runStep.step is not implementation.awaiting_input', async () => {
      const step = makeRunStep({ step: 'implementation.build' });
      const run = makeRun();
      const { runSteps } = makeRunStepDeps([step]);

      await expect(
        recordConvergenceEscalationGuidance(
          { run, runStep: step, guidance: 'guidance' },
          { runSteps }
        )
      ).rejects.toMatchObject({ name: 'ConvergenceCheckpointError', code: 'changed_step' });
    });

    it('throws invalid_pause when checkpoint is not a convergence escalation', async () => {
      const step = makeRunStep({ checkpointResult: null });
      const run = makeRun();
      const { runSteps } = makeRunStepDeps([step]);

      await expect(
        recordConvergenceEscalationGuidance(
          { run, runStep: step, guidance: 'guidance' },
          { runSteps }
        )
      ).rejects.toMatchObject({ name: 'ConvergenceCheckpointError', code: 'invalid_pause' });
    });
  });
});
