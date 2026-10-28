import { describe, expect, it } from 'vitest';

import {
  recoverRunSuccessStatusCode,
  runRecoveryPath,
  runRecoveryModeSchema,
  runRecoveryRequestSchema,
  runRecoveryResponseSchema
} from './run-recovery.js';

const sampleRun = {
  id: 'run_1',
  topicId: 'topic_1',
  owner: { kind: 'human' as const, id: 'user_1', tenantId: 'tenant_1' },
  tenant: 'tenant_1',
  workKind: 'feature',
  currentStep: 'implementation.build',
  terminal: false,
  createdAt: '2026-10-28T00:00:00.000Z',
  updatedAt: '2026-10-28T00:00:00.000Z'
};

describe('run-recovery contract', () => {
  it('exposes the canonical path and status code', () => {
    expect(runRecoveryPath).toBe('/v1/runs/:id/recover');
    expect(recoverRunSuccessStatusCode).toBe(200);
  });

  it('accepts a missing body treated as empty object', () => {
    expect(runRecoveryRequestSchema.parse({})).toEqual({});
  });

  it('accepts resume and start_over', () => {
    expect(runRecoveryRequestSchema.parse({ mode: 'resume' })).toEqual({ mode: 'resume' });
    expect(runRecoveryRequestSchema.parse({ mode: 'start_over' })).toEqual({ mode: 'start_over' });
  });

  it('rejects unknown fields', () => {
    expect(() => runRecoveryRequestSchema.parse({ mode: 'resume', extra: true })).toThrow();
  });

  it('rejects invalid modes', () => {
    expect(() => runRecoveryRequestSchema.parse({ mode: 'retry' })).toThrow();
    expect(() => runRecoveryModeSchema.parse('retry')).toThrow();
  });

  it('parses a response with run and mode', () => {
    const parsed = runRecoveryResponseSchema.parse({ run: sampleRun, mode: 'resume' });
    expect(parsed.mode).toBe('resume');
    expect(parsed.run.id).toBe('run_1');
  });

  it('rejects a response with an unknown field', () => {
    expect(() => runRecoveryResponseSchema.parse({ run: sampleRun, mode: 'resume', extra: 1 })).toThrow();
  });
});
