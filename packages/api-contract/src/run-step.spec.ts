import { describe, expect, it } from 'vitest';

import {
  listRunStepsSuccessStatusCode,
  runStepListResponseSchema,
  runStepsPath
} from './run-step.js';

describe('run-step contract extensions', () => {
  it('exports the run steps path constant', () => {
    expect(runStepsPath).toBe('/v1/runs/:id/steps');
  });

  it('exports the success status code constant', () => {
    expect(listRunStepsSuccessStatusCode).toBe(200);
  });

  it('parses a valid run step list response', () => {
    const now = new Date().toISOString();
    const validResponse = {
      steps: [
        {
          id: 'step_1',
          runId: 'run_1',
          phase: null,
          step: 'start',
          role: 'orchestrator',
          startedAt: now,
          endedAt: null,
          durationMs: null,
          occurrence: { index: 0, attempt: 1 }
        }
      ]
    };
    expect(runStepListResponseSchema.parse(validResponse)).toEqual(validResponse);
  });

  it('parses an empty steps list', () => {
    expect(runStepListResponseSchema.parse({ steps: [] })).toEqual({ steps: [] });
  });

  it('rejects extra fields (strict)', () => {
    expect(() => runStepListResponseSchema.parse({ steps: [], extra: 'field' })).toThrow();
  });
});
