import { describe, expect, it } from 'vitest';

import {
  createFilenameAliasNormalizer,
  createResultNormalizerRegistry,
  createUrlWrappedIdentifierNormalizer
} from './result-normalizers.js';

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
