import { describe, expect, it } from 'vitest';

import {
  createRunWorkKindSchema,
  getRunSuccessStatusCode,
  listRunsSuccessStatusCode,
  runCollectionPath,
  runIdParamsSchema,
  runListResponseSchema,
  runResourcePath,
  runSchema,
  waitingOnSchema
} from './run.js';

const validRun = {
  id: 'run_1',
  topicId: 'topic_1',
  owner: { kind: 'human' as const, id: 'user_1', tenantId: 'tenant_1' },
  tenant: 'tenant_1',
  workKind: 'feature',
  currentStep: 'spec.author',
  terminal: false,
  createdAt: '2026-06-11T12:00:00.000Z',
  updatedAt: '2026-06-11T12:00:00.000Z'
};

describe('run contract extensions', () => {
  it('exports the collection path constant', () => {
    expect(runCollectionPath).toBe('/v1/runs');
  });

  it('exports the resource path constant', () => {
    expect(runResourcePath).toBe('/v1/runs/:id');
  });

  it('exports the success status code constant', () => {
    expect(getRunSuccessStatusCode).toBe(200);
  });

  it('validates known work kinds', () => {
    const kinds = ['feature', 'enhancement', 'bug', 'chore', 'file_issue', 'question'];
    for (const kind of kinds) {
      expect(createRunWorkKindSchema.parse(kind)).toBe(kind);
    }
  });

  it('rejects unknown work kinds', () => {
    expect(() => createRunWorkKindSchema.parse('unknown_kind')).toThrow();
  });

  it('parses valid run id params', () => {
    expect(runIdParamsSchema.parse({ id: 'run_123' })).toEqual({ id: 'run_123' });
  });

  it('rejects empty id in params', () => {
    expect(() => runIdParamsSchema.parse({ id: '' })).toThrow();
  });

  it('rejects extra fields in params (strict)', () => {
    expect(() => runIdParamsSchema.parse({ id: 'run_1', extra: 'field' })).toThrow();
  });

  it('exports the run list success status code constant', () => {
    expect(listRunsSuccessStatusCode).toBe(200);
  });

  it('parses valid run list responses', () => {
    expect(runListResponseSchema.parse({ runs: [validRun] })).toEqual({ runs: [validRun] });
    expect(runListResponseSchema.parse({ runs: [] })).toEqual({ runs: [] });
    expect(runSchema.parse(validRun).id).toBe('run_1');
  });

  it('rejects invalid run list items', () => {
    expect(() => runListResponseSchema.parse({
      runs: [{ ...validRun, id: undefined }]
    })).toThrow();
  });

  it('rejects unknown top-level fields in run list responses', () => {
    expect(() => runListResponseSchema.parse({ runs: [], nextCursor: null })).toThrow();
  });

  it('accepts valid waitingOn values on run responses', () => {
    for (const waitingOn of ['system', 'ai', 'human', 'none'] as const) {
      expect(runSchema.parse({ ...validRun, waitingOn }).waitingOn).toBe(waitingOn);
    }
  });

  it('keeps waitingOn optional for additive compatibility', () => {
    const parsed = runSchema.parse(validRun);
    expect(parsed.waitingOn).toBeUndefined();
  });

  it('rejects invalid waitingOn values', () => {
    expect(() => runSchema.parse({ ...validRun, waitingOn: 'reviewer' })).toThrow();
  });

  it('parses run list responses with waitingOn', () => {
    expect(runListResponseSchema.parse({
      runs: [{ ...validRun, waitingOn: 'human' }]
    }).runs[0]?.waitingOn).toBe('human');
  });

  it('exports the waitingOn enum contract', () => {
    expect(waitingOnSchema.options).toEqual(['system', 'ai', 'human', 'none']);
  });

  it('accepts optional failureReason on failed run responses', () => {
    const parsed = runSchema.parse({
      ...validRun,
      currentStep: 'failed',
      terminal: true,
      failureReason: 'provider_auth_failed'
    });
    expect(parsed.failureReason).toBe('provider_auth_failed');
  });

  it('keeps failureReason optional for additive compatibility', () => {
    const parsed = runSchema.parse({ ...validRun, currentStep: 'failed', terminal: true });
    expect(parsed.failureReason).toBeUndefined();
  });

  it('rejects empty failureReason values', () => {
    expect(() => runSchema.parse({
      ...validRun,
      currentStep: 'failed',
      terminal: true,
      failureReason: ''
    })).toThrow();
  });

  it('rejects non-string failureReason values', () => {
    expect(() => runSchema.parse({
      ...validRun,
      currentStep: 'failed',
      terminal: true,
      failureReason: 401
    })).toThrow();
  });
});
