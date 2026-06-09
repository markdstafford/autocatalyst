import { describe, expect, it } from 'vitest';

import {
  runnerTerminalHandoffResultSchema,
  runnerTerminalStepResultSchema,
  stepResultContractSchema,
  stepResultSchemaIdSchema
} from './step-results.js';

describe('step result contracts', () => {
  it('validates non-empty schema ids and contract keys', () => {
    expect(stepResultSchemaIdSchema.safeParse('terminal-handoff.v1').success).toBe(true);
    expect(stepResultSchemaIdSchema.safeParse('').success).toBe(false);
    expect(stepResultContractSchema.safeParse({ step: 'implement', schemaId: 'terminal-handoff.v1' }).success).toBe(true);
    expect(stepResultContractSchema.safeParse({ step: '', schemaId: 'terminal-handoff.v1' }).success).toBe(false);
    expect(stepResultContractSchema.safeParse({ step: 'implement', schemaId: '' }).success).toBe(false);
  });

  it('accepts valid advance, needs_input, and fail terminal handoffs', () => {
    expect(runnerTerminalStepResultSchema.parse({ directive: 'advance', result: { artifact: 'plan.md' } })).toEqual({
      directive: 'advance',
      result: { artifact: 'plan.md' }
    });
    expect(runnerTerminalStepResultSchema.parse({ directive: 'needs_input', question: 'Which provider?' })).toEqual({
      directive: 'needs_input',
      question: 'Which provider?'
    });
    expect(runnerTerminalStepResultSchema.parse({ directive: 'fail', reason: 'Execution failed: schema_validation_failed' })).toEqual({
      directive: 'fail',
      reason: 'Execution failed: schema_validation_failed'
    });
    expect(runnerTerminalStepResultSchema.safeParse({ directive: 'needs_input', reason: 'bad' }).success).toBe(false);
    expect(runnerTerminalStepResultSchema.safeParse({ directive: 'fail', question: 'bad?' }).success).toBe(false);
  });

  it('accepts top-level result objects and rejects arrays or primitive result payloads', () => {
    expect(runnerTerminalStepResultSchema.safeParse({ directive: 'advance', result: { nested: { ok: true } } }).success).toBe(true);
    expect(runnerTerminalStepResultSchema.safeParse({ directive: 'advance', result: ['not', 'an', 'object'] }).success).toBe(false);
    expect(runnerTerminalStepResultSchema.safeParse({ directive: 'advance', result: 'not-object' }).success).toBe(false);
  });

  it('rejects missing required handoff fields and malformed directives', () => {
    expect(runnerTerminalHandoffResultSchema.safeParse({ schemaId: 'terminal-handoff.v1', result: { directive: 'advance' } }).success).toBe(false);
    expect(runnerTerminalHandoffResultSchema.safeParse({ step: 'implement', result: { directive: 'advance' } }).success).toBe(false);
    expect(runnerTerminalHandoffResultSchema.safeParse({ step: 'implement', schemaId: 'terminal-handoff.v1', result: {} }).success).toBe(false);
    expect(runnerTerminalStepResultSchema.safeParse({ directive: 'pause' }).success).toBe(false);
  });

  it('models post-validation execution-to-core handoff rather than raw runner terminal event payloads', () => {
    const parsed = runnerTerminalHandoffResultSchema.parse({
      step: 'implement',
      schemaId: 'terminal-handoff.v1',
      result: { directive: 'advance', result: { validated: true } }
    });

    expect(parsed.result.result).toEqual({ validated: true });
  });
});
