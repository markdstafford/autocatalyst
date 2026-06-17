import { describe, expect, it } from 'vitest';

import {
  createFilenameAliasNormalizer,
  createResultNormalizerRegistry,
  createUrlWrappedIdentifierNormalizer,
  defaultResultNormalizers,
  reviewerResultNormalizer
} from './result-normalizers.js';
import { REVIEWER_RESULT_SCHEMA_ID } from './result-contracts.js';

describe('result normalizers', () => {
  it('applies registered normalizers in order without changing pipeline control flow', () => {
    const registry = createResultNormalizerRegistry([
      { id: 'first', description: 'first change', normalize: ({ candidate }) => ({ status: 'changed', candidate: { ...(candidate as object), a: 1 }, message: 'set a' }) },
      { id: 'second', description: 'second change', normalize: ({ candidate }) => ({ status: 'changed', candidate: { ...(candidate as object), b: 2 }, message: 'set b' }) }
    ]);

    const output = registry.normalize({ candidate: {}, step: 'implement', schemaId: 'terminal-handoff.v1', attempt: 0 });

    expect(output.candidate).toEqual({ a: 1, b: 2 });
    expect(output.normalized).toBe(true);
    expect(output.events.map((event) => event.normalizerId)).toEqual(['first', 'second']);
  });

  it('records ambiguity without guessing or rolling back prior deterministic changes', () => {
    const registry = createResultNormalizerRegistry([
      { id: 'safe', description: 'safe', normalize: () => ({ status: 'changed', candidate: { filename: 'canonical.md' }, message: 'canonicalized' }) },
      { id: 'ambiguous', description: 'ambiguous', normalize: () => ({ status: 'ambiguous', message: 'multiple matches' }) }
    ]);

    const output = registry.normalize({ candidate: { filename: 'alias.md' }, step: 'implement', schemaId: 'terminal-handoff.v1', attempt: 0 });

    expect(output.candidate).toEqual({ filename: 'canonical.md' });
    expect(output.ambiguous).toBe(true);
    expect(output.events.some((event) => event.code === 'ambiguous_normalization')).toBe(true);
  });

  it('stops normalization and sets failed when a normalizer throws', () => {
    const registry = createResultNormalizerRegistry([
      { id: 'throwing', description: 'throws', normalize: () => { throw new Error('/secret/path'); } }
    ]);

    const output = registry.normalize({ candidate: {}, step: 'implement', schemaId: 'terminal-handoff.v1', attempt: 0 });

    expect(output.failed).toBe(true);
    expect(JSON.stringify(output)).not.toContain('/secret/path');
  });

  it('rejects duplicate normalizer ids', () => {
    expect(() => createResultNormalizerRegistry([
      { id: 'dup', description: 'a', normalize: () => ({ status: 'unchanged' }) },
      { id: 'dup', description: 'b', normalize: () => ({ status: 'unchanged' }) }
    ])).toThrow(/Duplicate normalizer id/);
  });

  it('filename alias normalizer maps explicit aliases to canonical values', () => {
    const normalizer = createFilenameAliasNormalizer({
      id: 'filename-alias',
      path: ['filename'],
      aliases: { README: 'README.md' }
    });

    expect(normalizer.normalize({ candidate: { filename: 'README' }, step: 'implement', schemaId: 'terminal-handoff.v1', attempt: 0 }))
      .toEqual({ status: 'changed', candidate: { filename: 'README.md' }, message: "Mapped filename alias 'README' to 'README.md'." });

    expect(normalizer.normalize({ candidate: { filename: 'unknown.md' }, step: 'implement', schemaId: 'terminal-handoff.v1', attempt: 0 }))
      .toEqual({ status: 'unchanged' });
  });

  it('URL-wrapped identifier normalizer extracts one unambiguous identifier', () => {
    const normalizer = createUrlWrappedIdentifierNormalizer({
      id: 'issue-url',
      path: ['issueId'],
      allowedOrigins: ['https://example.test'],
      identifierPattern: /issues\/(ISSUE-\d+)$/
    });

    expect(normalizer.normalize({ candidate: { issueId: 'https://example.test/issues/ISSUE-22' }, step: 'implement', schemaId: 'terminal-handoff.v1', attempt: 0 }))
      .toEqual({ status: 'changed', candidate: { issueId: 'ISSUE-22' }, message: 'Extracted identifier from URL.' });

    const ambiguous = normalizer.normalize({ candidate: { issueId: 'https://example.test/issues/ISSUE-22/also/ISSUE-23' }, step: 'implement', schemaId: 'terminal-handoff.v1', attempt: 0 });
    expect(ambiguous.status).toBe('ambiguous');
  });
});

describe('reviewerResultNormalizer', () => {
  const normalizeReviewer = (candidate: unknown, schemaId = REVIEWER_RESULT_SCHEMA_ID) =>
    reviewerResultNormalizer.normalize({
      candidate,
      step: 'implementation.build',
      schemaId,
      attempt: 0
    });

  it('normalizes an empty object to a satisfied reviewer result', () => {
    expect(normalizeReviewer({})).toEqual({
      status: 'changed',
      candidate: { status: 'satisfied', findings: [] },
      message: 'Normalized empty reviewer result to satisfied clean review.'
    });
  });

  it('normalizes an object containing only empty findings to a satisfied reviewer result', () => {
    expect(normalizeReviewer({ findings: [] })).toEqual({
      status: 'changed',
      candidate: { status: 'satisfied', findings: [] },
      message: 'Normalized empty reviewer findings to satisfied clean review.'
    });
  });

  it('leaves already-statused reviewer results for schema validation', () => {
    const alreadyStatused = { status: 'satisfied', findings: [] };
    expect(normalizeReviewer(alreadyStatused)).toEqual({ status: 'unchanged' });
    expect(normalizeReviewer({ status: 'unknown', findings: [] })).toEqual({ status: 'unchanged' });
  });

  it('leaves ambiguous or malformed reviewer candidates unchanged', () => {
    expect(normalizeReviewer({ findings: [{ title: 'Missing status', body: 'Ambiguous.', severity: 'blocker' }] }))
      .toEqual({ status: 'unchanged' });
    expect(normalizeReviewer({ findings: 'none' })).toEqual({ status: 'unchanged' });
    expect(normalizeReviewer([{ findings: [] }])).toEqual({ status: 'unchanged' });
    expect(normalizeReviewer(null)).toEqual({ status: 'unchanged' });
    expect(normalizeReviewer('')).toEqual({ status: 'unchanged' });
  });

  it('is schema-specific and is included in the default registry', () => {
    expect(normalizeReviewer({}, 'terminal-handoff.v1')).toEqual({ status: 'unchanged' });

    const registry = createResultNormalizerRegistry(defaultResultNormalizers);
    const output = registry.normalize({
      candidate: {},
      step: 'implementation.build',
      schemaId: REVIEWER_RESULT_SCHEMA_ID,
      attempt: 0
    });

    expect(defaultResultNormalizers).toContain(reviewerResultNormalizer);
    expect(output).toMatchObject({
      candidate: { status: 'satisfied', findings: [] },
      normalized: true,
      ambiguous: false,
      failed: false
    });
    expect(output.events).toEqual([
      {
        kind: 'normalized',
        normalizerId: 'reviewer-result-clean-review',
        message: 'Normalized empty reviewer result to satisfied clean review.'
      }
    ]);
  });
});
