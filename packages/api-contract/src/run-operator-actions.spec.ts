import { describe, expect, it } from 'vitest';
import { emptyRunActionRequestSchema, listRunsQuerySchema, renameRunRequestSchema, setRunStepRequestSchema } from './index.js';

describe('run operator action contracts', () => {
  it('accepts an empty object but not a supplied non-empty or non-object body', () => {
    expect(emptyRunActionRequestSchema.parse({})).toEqual({});
    for (const body of [null, [], '', 1, { extra: true }]) {
      expect(emptyRunActionRequestSchema.safeParse(body).success).toBe(false);
    }
  });

  it('requires one valid step or trimmed title field', () => {
    for (const body of [undefined, null, {}, { step: '' }, { step: 2 }, { step: 'spec.author', extra: true }]) {
      expect(setRunStepRequestSchema.safeParse(body).success).toBe(false);
    }
    expect(setRunStepRequestSchema.parse({ step: 'spec.author' })).toEqual({ step: 'spec.author' });
    for (const body of [undefined, null, {}, { title: ' ' }, { title: 2 }, { title: 'x'.repeat(201) }, { title: 'x', extra: true }]) {
      expect(renameRunRequestSchema.safeParse(body).success).toBe(false);
    }
    expect(renameRunRequestSchema.parse({ title: `  ${'x'.repeat(200)}  ` })).toEqual({ title: 'x'.repeat(200) });
    expect(listRunsQuerySchema.safeParse({ archived: 'maybe' }).success).toBe(false);
  });
});
