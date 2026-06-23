import { describe, expect, it } from 'vitest';

import {
  createFilenameAliasNormalizer,
  createResultNormalizerRegistry,
  createSpecAuthorFrontmatterNormalizer,
  createUrlWrappedIdentifierNormalizer,
  defaultResultNormalizers,
  implementerDispositionsNullStripNormalizer,
  prFinalizeCleanResultNormalizer,
  prFinalizeNullStripNormalizer,
  reviewerNullFindingsNormalizer,
  reviewerResultNormalizer
} from './result-normalizers.js';
import {
  IMPLEMENTER_DISPOSITIONS_SCHEMA_ID,
  PR_FINALIZE_SCHEMA_ID,
  REVIEWER_RESULT_SCHEMA_ID,
  SPEC_AUTHOR_SCHEMA_ID
} from './result-contracts.js';
import {
  implementerDispositionsResultSchema,
  prFinalizeResultSchema,
  reviewerResultSchema
} from '@autocatalyst/api-contract';

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

  it('leaves an empty object unchanged so a missing verdict is a real fault, not a fabricated satisfied', () => {
    expect(normalizeReviewer({})).toEqual({ status: 'unchanged' });
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

  it('leaves non-plain objects unchanged — Date, Map, and class instances must not be normalized', () => {
    expect(normalizeReviewer(new Date())).toEqual({ status: 'unchanged' });
    expect(normalizeReviewer(new Map())).toEqual({ status: 'unchanged' });
    class Review {}
    expect(normalizeReviewer(new Review())).toEqual({ status: 'unchanged' });
  });

  it('is schema-specific and is included in the default registry', () => {
    expect(normalizeReviewer({ findings: [] }, 'terminal-handoff.v1')).toEqual({ status: 'unchanged' });

    const registry = createResultNormalizerRegistry(defaultResultNormalizers);
    const output = registry.normalize({
      candidate: { findings: [] },
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
        message: 'Normalized empty reviewer findings to satisfied clean review.'
      }
    ]);
  });
});

describe('createSpecAuthorFrontmatterNormalizer', () => {
  const normalize = (candidate: unknown, schemaId = SPEC_AUTHOR_SCHEMA_ID) => createSpecAuthorFrontmatterNormalizer({
    clock: () => '2026-06-18T12:00:00.000Z',
    trustedSpeccedBy: 'autocatalyst',
    trackedIssueNumber: 83
  }).normalize({ candidate, step: 'spec.author', schemaId, attempt: 0 });

  it('drops stray frontmatter keys, removes optional nulls, and stamps system-owned fields', () => {
    const result = normalize({
      kind: 'feature_spec',
      slug: 'tolerant-results',
      relativePath: 'context-human/specs/feature-tolerant-results.md',
      frontmatter: {
        created: '1999-01-01',
        last_updated: '1999-01-01',
        status: 'complete',
        issue: 999,
        issue_url: 'https://example.test/issue/999',
        implemented_by: null,
        supersedes: 'old-spec',
        extra: 'remove me',
        specced_by: 'model'
      },
      body: '# Tolerant results\n\nBody.'
    });

    expect(result.status).toBe('changed');
    if (result.status !== 'changed') return;
    expect(result.candidate).toMatchObject({
      frontmatter: {
        created: '2026-06-18',
        last_updated: '2026-06-18',
        status: 'draft',
        issue: 83,
        supersedes: 'old-spec',
        specced_by: 'autocatalyst'
      }
    });
    expect(JSON.stringify(result.candidate)).not.toContain('issue_url');
    expect(JSON.stringify(result.candidate)).not.toContain('implemented_by');
    expect(JSON.stringify(result.candidate)).not.toContain('extra');
  });

  it('is schema-id gated and leaves invalid top-level fields for schema validation', () => {
    const candidate = { frontmatter: { extra: 'x' }, body: 7 };
    expect(normalize(candidate, 'other.schema')).toEqual({ status: 'unchanged' });

    const result = normalize(candidate);
    expect(result.status).toBe('changed');
    if (result.status !== 'changed') return;
    expect((result.candidate as { body: unknown }).body).toBe(7);
  });
});

describe('reviewerNullFindingsNormalizer', () => {
  const normalize = (candidate: unknown, schemaId = REVIEWER_RESULT_SCHEMA_ID) =>
    reviewerNullFindingsNormalizer.normalize({ candidate, step: 'implementation.build', schemaId, attempt: 0 });

  it('strips findings: null from reviewer results', () => {
    expect(normalize({ status: 'satisfied', findings: null })).toEqual({
      status: 'changed',
      candidate: { status: 'satisfied' },
      message: 'Stripped null findings from reviewer result.'
    });
  });

  it('is unchanged when findings is not null', () => {
    expect(normalize({ status: 'satisfied', findings: [] })).toEqual({ status: 'unchanged' });
    expect(normalize({ status: 'satisfied' })).toEqual({ status: 'unchanged' });
  });

  it('is schema-id gated', () => {
    expect(normalize({ findings: null }, 'other.schema')).toEqual({ status: 'unchanged' });
  });
});

describe('implementerDispositionsNullStripNormalizer', () => {
  const normalize = (candidate: unknown, schemaId = IMPLEMENTER_DISPOSITIONS_SCHEMA_ID) =>
    implementerDispositionsNullStripNormalizer.normalize({ candidate, step: 'implementation.build', schemaId, attempt: 0 });

  it('strips dispositions: null from implementer dispositions results', () => {
    expect(normalize({ dispositions: null })).toEqual({
      status: 'changed',
      candidate: {},
      message: 'Stripped null dispositions from implementer dispositions result.'
    });
  });

  it('is unchanged when dispositions is an array', () => {
    expect(normalize({ dispositions: [] })).toEqual({ status: 'unchanged' });
    expect(normalize({})).toEqual({ status: 'unchanged' });
  });

  it('is schema-id gated', () => {
    expect(normalize({ dispositions: null }, 'other.schema')).toEqual({ status: 'unchanged' });
  });
});

describe('prFinalizeNullStripNormalizer', () => {
  const normalize = (candidate: unknown, schemaId = PR_FINALIZE_SCHEMA_ID) =>
    prFinalizeNullStripNormalizer.normalize({ candidate, step: 'pr.finalize', schemaId, attempt: 0 });

  it('strips all three null optional fields', () => {
    const result = normalize({
      directive: 'advance',
      findings: [],
      reconciledSummary: null,
      titleSubject: null,
      validationSummary: null
    });
    expect(result.status).toBe('changed');
    if (result.status !== 'changed') return;
    expect(result.candidate).toEqual({ directive: 'advance', findings: [] });
    expect(result.message).toContain('reconciledSummary');
    expect(result.message).toContain('titleSubject');
    expect(result.message).toContain('validationSummary');
  });

  it('strips only the null fields, leaving non-null optional fields intact', () => {
    const result = normalize({ directive: 'advance', findings: [], reconciledSummary: null, titleSubject: 'fix: something' });
    expect(result.status).toBe('changed');
    if (result.status !== 'changed') return;
    expect(result.candidate).toEqual({ directive: 'advance', findings: [], titleSubject: 'fix: something' });
  });

  it('is unchanged when no null optional fields are present', () => {
    expect(normalize({ directive: 'advance', findings: [] })).toEqual({ status: 'unchanged' });
    expect(normalize({ directive: 'advance', findings: [], titleSubject: 'fix: something' })).toEqual({ status: 'unchanged' });
  });

  it('is schema-id gated', () => {
    expect(normalize({ reconciledSummary: null }, 'other.schema')).toEqual({ status: 'unchanged' });
  });
});

describe('end-to-end: canonical schema validation passes after normalization', () => {
  it('reviewer: { status: "satisfied", findings: null } passes reviewerResultSchema after reviewerNullFindingsNormalizer', () => {
    const input = { status: 'satisfied', findings: null };
    const normalized = reviewerNullFindingsNormalizer.normalize({
      candidate: input,
      step: 'implementation.build',
      schemaId: REVIEWER_RESULT_SCHEMA_ID,
      attempt: 0
    });
    expect(normalized.status).toBe('changed');
    if (normalized.status !== 'changed') return;
    expect(() => reviewerResultSchema.parse(normalized.candidate)).not.toThrow();
  });

  it('implementer: { dispositions: null } passes implementerDispositionsResultSchema after implementerDispositionsNullStripNormalizer', () => {
    const input = { dispositions: null };
    const normalized = implementerDispositionsNullStripNormalizer.normalize({
      candidate: input,
      step: 'implementation.build',
      schemaId: IMPLEMENTER_DISPOSITIONS_SCHEMA_ID,
      attempt: 0
    });
    expect(normalized.status).toBe('changed');
    if (normalized.status !== 'changed') return;
    expect(() => implementerDispositionsResultSchema.parse(normalized.candidate)).not.toThrow();
  });

  it('pr.finalize: null optional fields pass prFinalizeResultSchema after prFinalizeNullStripNormalizer', () => {
    const input = { directive: 'advance', findings: [], reconciledSummary: null, titleSubject: null, validationSummary: null };
    const normalized = prFinalizeNullStripNormalizer.normalize({
      candidate: input,
      step: 'pr.finalize',
      schemaId: PR_FINALIZE_SCHEMA_ID,
      attempt: 0
    });
    expect(normalized.status).toBe('changed');
    if (normalized.status !== 'changed') return;
    expect(() => prFinalizeResultSchema.parse(normalized.candidate)).not.toThrow();
  });
});

describe('prFinalizeCleanResultNormalizer', () => {
  const normalize = (candidate: unknown, schemaId = PR_FINALIZE_SCHEMA_ID) =>
    prFinalizeCleanResultNormalizer.normalize({ candidate, step: 'pr.finalize', schemaId, attempt: 0 });

  it('normalizes omission-only clean PR-finalize results', () => {
    expect(normalize({})).toEqual({
      status: 'changed',
      candidate: { directive: 'advance', findings: [] },
      message: 'Normalized empty pr.finalize result to clean advance.'
    });
    expect(normalize({ findings: [] })).toEqual({
      status: 'changed',
      candidate: { directive: 'advance', findings: [] },
      message: 'Normalized empty pr.finalize findings to clean advance.'
    });
    expect(normalize({ validationSummary: [] })).toEqual({
      status: 'changed',
      candidate: { directive: 'advance', validationSummary: [], findings: [] },
      message: 'Normalized omission-only pr.finalize result to clean advance.'
    });
  });

  it('does not guess ambiguous or contradictory candidates', () => {
    expect(normalize({ unexpected: true })).toEqual({ status: 'unchanged' });
    expect(normalize({ directive: 'ship', findings: [] })).toEqual({ status: 'unchanged' });
    expect(normalize({ findings: [{ severity: 'blocker', summary: 'Fix' }] })).toEqual({ status: 'unchanged' });
    expect(normalize({ directive: 'advance', findings: [{ severity: 'blocker', summary: 'Fix' }] })).toEqual({ status: 'unchanged' });
    expect(normalize({}, 'other.schema')).toEqual({ status: 'unchanged' });
  });
});
