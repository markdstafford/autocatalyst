import type { RunStep } from '@autocatalyst/api-contract';
import { expect, it } from 'vitest';

import { runStepCandidates } from './run-action-history.js';
import { makeRun } from './run-fixtures.js';

it('keeps first-reached order, removes repeated/current steps, and ignores null phases', () => {
  const run = makeRun();
  const attempt = (step: string, index: number, phase: string | null = 'spec'): RunStep => ({
    id: `step-${index}`, runId: run.id, step, phase, role: 'implementer', occurrence: { index, attempt: 1 },
    startedAt: run.createdAt, endedAt: run.createdAt, durationMs: 0, checkpointResult: null
  });
  expect(runStepCandidates(run, [
    attempt('repeat', 5), attempt(run.currentStep, 6), attempt('phase-less', 1, null),
    attempt('second', 3), attempt(run.currentStep, 2), attempt('repeat', 0)
  ])).toEqual(['repeat', 'second']);
  expect(runStepCandidates(run, [attempt(run.currentStep, 0), attempt('skipped', 1, null)])).toEqual([]);
  expect(runStepCandidates(run, undefined)).toEqual([]);
});
