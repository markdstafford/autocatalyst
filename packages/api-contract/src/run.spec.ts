import { describe, expect, it } from 'vitest';

import {
  createRunWorkKindSchema,
  getRunSuccessStatusCode,
  runCollectionPath,
  runIdParamsSchema,
  runResourcePath
} from './run.js';

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
});
