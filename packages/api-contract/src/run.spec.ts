import { describe, expect, it } from 'vitest';

import {
  createRunWorkKindSchema,
  decodeRunListCursor,
  encodeRunListCursor,
  getRunSuccessStatusCode,
  listRunsQuerySchema,
  listRunsSuccessStatusCode,
  maxRunListLimit,
  runCollectionPath,
  runIdParamsSchema,
  runListResponseSchema,
  runResourcePath,
  runSchema,
  runStatusSchema,
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
    expect(() => runListResponseSchema.parse({ runs: [], unknownField: 'x' })).toThrow();
  });

  it('accepts an optional nextCursor on run list responses', () => {
    expect(runListResponseSchema.parse({ runs: [], nextCursor: 'opaque' })).toEqual({ runs: [], nextCursor: 'opaque' });
    expect(runListResponseSchema.parse({ runs: [] }).nextCursor).toBeUndefined();
  });

  it('rejects non-string or empty nextCursor values', () => {
    expect(() => runListResponseSchema.parse({ runs: [], nextCursor: null })).toThrow();
    expect(() => runListResponseSchema.parse({ runs: [], nextCursor: '' })).toThrow();
  });

  it('accepts optional status and projectId on run read responses', () => {
    const parsed = runSchema.parse({ ...validRun, status: 'in_progress', projectId: 'proj_1' });
    expect(parsed.status).toBe('in_progress');
    expect(parsed.projectId).toBe('proj_1');
  });

  it('keeps status and projectId optional for stored/event runs', () => {
    const parsed = runSchema.parse(validRun);
    expect(parsed.status).toBeUndefined();
    expect(parsed.projectId).toBeUndefined();
  });

  it('limits status to the four derived values', () => {
    for (const status of ['in_progress', 'done', 'failed', 'canceled'] as const) {
      expect(runStatusSchema.parse(status)).toBe(status);
    }
    expect(() => runStatusSchema.parse('paused')).toThrow();
    expect(() => runSchema.parse({ ...validRun, status: 'paused' })).toThrow();
  });

  it('exposes the max list limit constant', () => {
    expect(maxRunListLimit).toBe(100);
  });

  describe('listRunsQuerySchema', () => {
    it('parses an empty query', () => {
      expect(listRunsQuerySchema.parse({})).toEqual({});
    });

    it('splits comma-separated filters and de-duplicates them', () => {
      const parsed = listRunsQuerySchema.parse({
        status: 'failed,in_progress,failed',
        waitingOn: 'human',
        workKind: 'enhancement,bug',
        projectId: 'proj_1,proj_2,proj_1'
      });
      expect(parsed.status).toEqual(['failed', 'in_progress']);
      expect(parsed.waitingOn).toEqual(['human']);
      expect(parsed.workKind).toEqual(['enhancement', 'bug']);
      expect(parsed.projectId).toEqual(['proj_1', 'proj_2']);
    });

    it('treats a comma in projectId as the multi-id separator, not a rejectable value', () => {
      // Per spec "API experience": projectId is one comma-separated value per field, and a project
      // id the tenant does not own returns an empty page rather than a 400. Real project ids are
      // `proj_<uuid>` and never contain commas, so `projectId=proj,1` is two unowned ids
      // ['proj','1'] (-> empty page), structurally identical to the accepted multi-id
      // `proj_1,proj_2`. A single id that embeds a comma is unrepresentable because commas are the
      // delimiter; the "project ids must not contain commas" invariant holds because each split
      // item is comma-free (empty items are rejected above). Rejecting this value would also break
      // the required multi-project filter `projectId=proj_1,proj_2`.
      expect(listRunsQuerySchema.parse({ projectId: 'proj,1' }).projectId).toEqual(['proj', '1']);
    });

    it('accepts limit and cursor', () => {
      const parsed = listRunsQuerySchema.parse({ limit: '25', cursor: 'opaque' });
      expect(parsed.limit).toBe(25);
      expect(parsed.cursor).toBe('opaque');
    });

    it('rejects repeated keys delivered as arrays', () => {
      expect(() => listRunsQuerySchema.parse({ status: ['failed', 'in_progress'] })).toThrow();
    });

    it('rejects empty comma items', () => {
      expect(() => listRunsQuerySchema.parse({ status: 'failed,' })).toThrow();
      expect(() => listRunsQuerySchema.parse({ status: ',' })).toThrow();
      expect(() => listRunsQuerySchema.parse({ status: '' })).toThrow();
      expect(() => listRunsQuerySchema.parse({ projectId: 'proj_1,' })).toThrow();
    });

    it('rejects invalid enum values', () => {
      expect(() => listRunsQuerySchema.parse({ status: 'paused' })).toThrow();
      expect(() => listRunsQuerySchema.parse({ waitingOn: 'reviewer' })).toThrow();
      expect(() => listRunsQuerySchema.parse({ workKind: 'nonsense' })).toThrow();
    });

    it('rejects unknown query fields', () => {
      expect(() => listRunsQuerySchema.parse({ unknown: 'x' })).toThrow();
    });

    it('rejects non-positive, fractional, and oversized limits', () => {
      expect(() => listRunsQuerySchema.parse({ limit: '0' })).toThrow();
      expect(() => listRunsQuerySchema.parse({ limit: '-1' })).toThrow();
      expect(() => listRunsQuerySchema.parse({ limit: '1.5' })).toThrow();
      expect(() => listRunsQuerySchema.parse({ limit: '101' })).toThrow();
      expect(() => listRunsQuerySchema.parse({ limit: 'abc' })).toThrow();
    });
  });

  describe('run list cursor', () => {
    it('round-trips an ordered-position cursor', () => {
      const cursor = { createdAt: '2026-11-01T12:00:00.000Z', id: 'run_123' };
      const encoded = encodeRunListCursor(cursor);
      expect(typeof encoded).toBe('string');
      expect(decodeRunListCursor(encoded)).toEqual(cursor);
    });

    it('produces a URL-safe opaque string', () => {
      const encoded = encodeRunListCursor({ createdAt: '2026-11-01T12:00:00.000Z', id: 'run_123' });
      expect(encoded).not.toMatch(/[+/=]/u);
    });

    it('throws a ZodError on malformed cursors', () => {
      expect(() => decodeRunListCursor('not-base64-$$$')).toThrow();
      expect(() => decodeRunListCursor(encodeRunListCursor({ createdAt: '2026-11-01T12:00:00.000Z', id: 'run_1' }).slice(0, 3) + '!!')).toThrow();
      expect(() => decodeRunListCursor(btoa('{"createdAt":"nope","id":"run_1"}'))).toThrow();
    });
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
