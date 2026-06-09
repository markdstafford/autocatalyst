import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { validateStepResult } from './result-tolerance.js';
import { createFilenameAliasNormalizer, createResultNormalizerRegistry } from './result-normalizers.js';

const schema = z.object({ filename: z.string(), optionalSignal: z.string().optional() }).strict();

const baseInput = {
  runId: 'run_1',
  step: 'implement',
  schemaId: 'terminal-handoff.v1',
  schema
};

describe('validateStepResult', () => {
  it('applies deterministic repair before validation without correction', async () => {
    const correctionCalls: unknown[] = [];
    const result = await validateStepResult({
      ...baseInput,
      candidate: { filename: 'README' },
      normalizers: [createFilenameAliasNormalizer({ id: 'filename-alias', path: ['filename'], aliases: { README: 'README.md' } })],
      correctionRequester: { async requestCorrection(request) { correctionCalls.push(request); return { filename: 'unused.md' }; } }
    });

    expect(result).toMatchObject({ status: 'valid', normalized: true, correctedAttempts: 0 });
    expect(result.status === 'valid' ? result.value.filename : undefined).toBe('README.md');
    expect(correctionCalls).toHaveLength(0);
  });

  it('does not coerce ambiguous input and enters correction when validation fails', async () => {
    const attempts: number[] = [];
    const result = await validateStepResult({
      ...baseInput,
      candidate: { filename: 42 },
      normalizers: createResultNormalizerRegistry([
        { id: 'ambiguous-filename', description: 'ambiguous filename', normalize: () => ({ status: 'ambiguous', message: 'multiple possible filenames' }) }
      ]),
      maxCorrectionAttempts: 1,
      correctionRequester: { async requestCorrection(request) { attempts.push(request.attempt); return { filename: 'fixed.md' }; } }
    });

    expect(result).toMatchObject({ status: 'valid', correctedAttempts: 1 });
    expect(result.events.some((event) => event.code === 'ambiguous_normalization')).toBe(true);
    expect(attempts).toEqual([1]);
  });

  it('makes exactly the configured number of correction requests before exhaustion', async () => {
    const attempts: number[] = [];
    const result = await validateStepResult({
      ...baseInput,
      candidate: { filename: 42 },
      maxCorrectionAttempts: 2,
      correctionRequester: { async requestCorrection(request) { attempts.push(request.attempt); return { filename: 43 }; } }
    });

    expect(result).toMatchObject({ status: 'failed', code: 'correction_attempts_exhausted', attempts: 2 });
    expect(attempts).toEqual([1, 2]);
  });

  it('records explicit optional-signal degradation without mutating parsed values', async () => {
    const result = await validateStepResult({
      ...baseInput,
      candidate: { filename: 'ok.md' },
      degradationPolicy: { optionalPaths: [['optionalSignal'], ['nested', 'missing']] }
    });

    expect(result).toMatchObject({ status: 'valid', degraded: true });
    if (result.status === 'valid') {
      expect(result.value).toEqual({ filename: 'ok.md' });
      expect(result.degradedPaths).toEqual([['optionalSignal'], ['nested', 'missing']]);
    }
  });

  it('treats null as present for degradation and lets schema decide validity', async () => {
    const nullableSchema = z.object({ optionalSignal: z.string().nullable().optional() }).strict();
    const result = await validateStepResult({
      runId: 'run_1',
      step: 'implement',
      schemaId: 'terminal-handoff.v1',
      schema: nullableSchema,
      candidate: { optionalSignal: null },
      degradationPolicy: { optionalPaths: [['optionalSignal']] }
    });

    expect(result).toMatchObject({ status: 'valid', degraded: false });
  });

  it('fails missing required fields', async () => {
    const result = await validateStepResult({ ...baseInput, candidate: {} });

    expect(result).toMatchObject({ status: 'failed', code: 'schema_validation_failed' });
  });

  it('returns sanitized normalizer_failed and skips correction when a normalizer throws', async () => {
    const result = await validateStepResult({
      ...baseInput,
      candidate: { filename: 'ok.md' },
      normalizers: [{ id: 'throwing', description: 'throws', normalize: () => { throw new Error('/secret/path raw output'); } }],
      correctionRequester: { async requestCorrection() { return { filename: 'fixed.md' }; } }
    });

    expect(result).toMatchObject({ status: 'failed', code: 'normalizer_failed', attempts: 0 });
    expect(JSON.stringify(result)).not.toContain('/secret/path');
  });

  it('returns schema_validation_failed when no correction requester is configured', async () => {
    const result = await validateStepResult({ ...baseInput, candidate: { filename: 42 } });
    expect(result).toMatchObject({ status: 'failed', code: 'schema_validation_failed' });
  });

  it('present optional fields do not set degraded metadata', async () => {
    const result = await validateStepResult({
      ...baseInput,
      candidate: { filename: 'ok.md', optionalSignal: 'present' },
      degradationPolicy: { optionalPaths: [['optionalSignal']] }
    });

    expect(result).toMatchObject({ status: 'valid', degraded: false, degradedPaths: [] });
  });
});
