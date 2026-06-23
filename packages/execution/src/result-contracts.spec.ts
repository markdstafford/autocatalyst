import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { prFinalizeResultSchema } from '@autocatalyst/api-contract';

import {
  SPEC_AUTHOR_SCHEMA_ID,
  REVIEWER_RESULT_SCHEMA_ID,
  IMPLEMENTER_DISPOSITIONS_SCHEMA_ID,
  PR_FINALIZE_SCHEMA_ID,
  createStepResultContractRegistry,
  resolveStepResultContract,
  registerReviewerResultContract,
  registerImplementerDispositionsResultContract,
  registerSpecAuthorResultContract,
  registerPullRequestFinalizeResultContract,
  stampSpecAuthorResultIdentity,
  SYSTEM_SPEC_AUTHOR_SPECCED_BY
} from './result-contracts.js';

const schema = z.object({ artifact: z.string() }).strict();

describe('step result contract registry', () => {
  it('resolves exact step/schema-id pairs', () => {
    const registry = createStepResultContractRegistry([
      { step: 'implement', schemaId: 'terminal-handoff.v1', schema, resultFile: 'result.json' }
    ]);

    const result = resolveStepResultContract({ registry, step: 'implement', schemaId: 'terminal-handoff.v1' });

    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') {
      expect(result.contract.resultFile).toBe('result.json');
      expect(result.contract.schema).toBe(schema);
    }
  });

  it('rejects duplicate step/schema-id registrations', () => {
    expect(() => createStepResultContractRegistry([
      { step: 'implement', schemaId: 'terminal-handoff.v1', schema },
      { step: 'implement', schemaId: 'terminal-handoff.v1', schema }
    ])).toThrow(/Duplicate step result contract/);
  });

  it('returns sanitized missing failures for omitted selection values', () => {
    const registry = createStepResultContractRegistry();

    expect(resolveStepResultContract({ registry, step: '', schemaId: 'terminal-handoff.v1' })).toMatchObject({
      status: 'failed',
      code: 'result_contract_missing'
    });
    expect(resolveStepResultContract({ registry, step: 'implement' })).toMatchObject({
      status: 'failed',
      code: 'result_contract_missing'
    });
  });

  it('returns sanitized unknown failures without falling back to generic schemas', () => {
    const registry = createStepResultContractRegistry([
      { step: 'design', schemaId: 'terminal-handoff.v1', schema }
    ]);

    const result = resolveStepResultContract({ registry, step: 'implement', schemaId: 'terminal-handoff.v1' });

    expect(result).toMatchObject({ status: 'failed', code: 'result_contract_unknown' });
    if (result.status === 'failed') {
      expect(result.safeMessage).toBe('Unknown step result contract for step and schemaId.');
      expect(JSON.stringify(result)).not.toContain('/');
    }
  });

  it('stores contract-owned normalizers and validation policy', () => {
    const normalizer = { id: 'n', description: 'n', normalize: () => ({ status: 'unchanged' as const }) };
    const correctionRequester = { requestCorrection: async () => ({ ok: true }) };
    const registry = createStepResultContractRegistry([
      {
        step: 'example.step',
        schemaId: 'example.v1',
        schema,
        normalizers: [normalizer],
        correctionRequester,
        maxCorrectionAttempts: 1,
        degradationPolicy: { optionalPaths: [['optional']] }
      }
    ]);

    const resolution = registry.resolve({ step: 'example.step', schemaId: 'example.v1' });
    expect(resolution.status).toBe('resolved');
    if (resolution.status !== 'resolved') return;
    expect(resolution.contract.normalizers).toEqual([normalizer]);
    expect(resolution.contract.correctionRequester).toBe(correctionRequester);
    expect(resolution.contract.maxCorrectionAttempts).toBe(1);
    expect(resolution.contract.degradationPolicy).toEqual({ optionalPaths: [['optional']] });
  });
});

describe('spec author result contract registration', () => {
  it('exports SPEC_AUTHOR_SCHEMA_ID as autocatalyst.spec_author.v1', () => {
    expect(SPEC_AUTHOR_SCHEMA_ID).toBe('autocatalyst.spec_author.v1');
  });

  it('registers autocatalyst.spec_author.v1 for spec.author', () => {
    const registry = registerSpecAuthorResultContract(createStepResultContractRegistry());
    const resolution = registry.resolve({ step: 'spec.author', schemaId: SPEC_AUTHOR_SCHEMA_ID });
    expect(resolution.status).toBe('resolved');
    if (resolution.status !== 'resolved') return;
    expect(resolution.contract.schemaId).toBe('autocatalyst.spec_author.v1');
  });

  it('keeps unknown schemaIds in the existing failure path', () => {
    const registry = registerSpecAuthorResultContract(createStepResultContractRegistry());
    const resolution = registry.resolve({ step: 'spec.author', schemaId: 'unknown.schema' });
    expect(resolution.status).toBe('failed');
    if (resolution.status !== 'failed') return;
    expect(resolution.code).toBe('result_contract_unknown');
  });

  it('does not affect existing contracts for other steps', () => {
    const baseRegistry = createStepResultContractRegistry();
    const withSpec = registerSpecAuthorResultContract(baseRegistry);
    // Resolving a different step should still get result_contract_missing
    const resolution = withSpec.resolve({ step: 'spec.author', schemaId: undefined });
    expect(resolution.status).toBe('failed');
    if (resolution.status !== 'failed') return;
    expect(resolution.code).toBe('result_contract_missing');
  });

  it('stamps omitted model specced_by with the trusted service identity before validation', () => {
    const registry = registerSpecAuthorResultContract(createStepResultContractRegistry());
    const resolution = registry.resolve({ step: 'spec.author', schemaId: SPEC_AUTHOR_SCHEMA_ID });
    expect(resolution.status).toBe('resolved');
    if (resolution.status !== 'resolved') return;

    const parsed = resolution.contract.schema.parse({
      kind: 'feature_spec',
      slug: 'real-prompts',
      relativePath: 'context-human/specs/feature-real-prompts.md',
      frontmatter: {
        created: '2026-06-16',
        last_updated: '2026-06-16',
        status: 'draft'
      },
      body: '# Real prompts\n\nBody.'
    });

    expect(parsed.frontmatter.specced_by).toBe(SYSTEM_SPEC_AUTHOR_SPECCED_BY);
  });

  it('overwrites invalid model specced_by with the trusted service identity before validation', () => {
    const registry = registerSpecAuthorResultContract(createStepResultContractRegistry());
    const resolution = registry.resolve({ step: 'spec.author', schemaId: SPEC_AUTHOR_SCHEMA_ID });
    expect(resolution.status).toBe('resolved');
    if (resolution.status !== 'resolved') return;

    const parsed = resolution.contract.schema.parse({
      kind: 'feature_spec',
      slug: 'identity-stamping',
      relativePath: 'context-human/specs/feature-identity-stamping.md',
      frontmatter: {
        created: '2026-06-16',
        last_updated: '2026-06-16',
        status: 'draft',
        specced_by: 'autocatalyst:mm:planning'
      },
      body: '# Identity stamping\n\nBody.'
    });

    expect(parsed.frontmatter.specced_by).toBe('autocatalyst');
  });

  it('stamps trustedSpeccedBy with the provided GitHub username instead of the service fallback', () => {
    const registry = registerSpecAuthorResultContract(createStepResultContractRegistry(), {
      trustedSpeccedBy: 'markdstafford'
    });
    const resolution = registry.resolve({ step: 'spec.author', schemaId: SPEC_AUTHOR_SCHEMA_ID });
    expect(resolution.status).toBe('resolved');
    if (resolution.status !== 'resolved') return;

    const parsed = resolution.contract.schema.parse({
      kind: 'feature_spec',
      slug: 'github-identity',
      relativePath: 'context-human/specs/feature-github-identity.md',
      frontmatter: {
        created: '2026-06-16',
        last_updated: '2026-06-16',
        status: 'draft'
      },
      body: '# GitHub identity\n\nBody.'
    });

    expect(parsed.frontmatter.specced_by).toBe('markdstafford');
  });

  it('stamps omitted system-owned frontmatter before validation', () => {
    const registry = registerSpecAuthorResultContract(createStepResultContractRegistry(), {
      clock: () => '2026-06-17T20:17:59.000Z',
      trackedIssueNumber: 76
    });
    const resolution = registry.resolve({ step: 'spec.author', schemaId: SPEC_AUTHOR_SCHEMA_ID });
    expect(resolution.status).toBe('resolved');
    if (resolution.status !== 'resolved') return;

    const parsed = resolution.contract.schema.parse({
      kind: 'feature_spec',
      slug: 'system-frontmatter',
      relativePath: 'context-human/specs/feature-system-frontmatter.md',
      frontmatter: {},
      body: '# System frontmatter\n\nBody.'
    });

    expect(parsed.frontmatter).toMatchObject({
      created: '2026-06-17',
      last_updated: '2026-06-17',
      status: 'draft',
      issue: 76,
      specced_by: SYSTEM_SPEC_AUTHOR_SPECCED_BY
    });
  });

  it('overwrites ISO timestamp dates with date-only values from the injected clock', () => {
    const registry = registerSpecAuthorResultContract(createStepResultContractRegistry(), {
      clock: () => '2026-06-18T01:02:03.000Z'
    });
    const resolution = registry.resolve({ step: 'spec.author', schemaId: SPEC_AUTHOR_SCHEMA_ID });
    expect(resolution.status).toBe('resolved');
    if (resolution.status !== 'resolved') return;

    const parsed = resolution.contract.schema.parse({
      kind: 'feature_spec',
      slug: 'date-stamping',
      relativePath: 'context-human/specs/feature-date-stamping.md',
      frontmatter: {
        created: '2026-06-17T20:17:59Z',
        last_updated: '2026-06-17T20:17:59Z',
        status: 'approved',
        specced_by: 'autocatalyst:mm:planning'
      },
      body: '# Date stamping\n\nBody.'
    });

    expect(parsed.frontmatter.created).toBe('2026-06-18');
    expect(parsed.frontmatter.last_updated).toBe('2026-06-18');
    expect(parsed.frontmatter.status).toBe('draft');
    expect(parsed.frontmatter.specced_by).toBe(SYSTEM_SPEC_AUTHOR_SPECCED_BY);
  });

  it('stamps tracked issue over omitted or misstated model issue values', () => {
    const registry = registerSpecAuthorResultContract(createStepResultContractRegistry(), {
      clock: () => '2026-06-17T00:00:00.000Z',
      trackedIssueNumber: 76
    });
    const resolution = registry.resolve({ step: 'spec.author', schemaId: SPEC_AUTHOR_SCHEMA_ID });
    expect(resolution.status).toBe('resolved');
    if (resolution.status !== 'resolved') return;

    const parsed = resolution.contract.schema.parse({
      kind: 'feature_spec',
      slug: 'issue-stamping',
      relativePath: 'context-human/specs/feature-issue-stamping.md',
      frontmatter: {
        created: '2026-06-01',
        last_updated: '2026-06-01',
        status: 'complete',
        issue: 999,
        specced_by: 'bad identity with spaces'
      },
      body: '# Issue stamping\n\nBody.'
    });

    expect(parsed.frontmatter.issue).toBe(76);
    expect(parsed.frontmatter.status).toBe('draft');
  });

  it('omits a model-invented issue when the run has no tracked issue', () => {
    const registry = registerSpecAuthorResultContract(createStepResultContractRegistry(), {
      clock: () => '2026-06-17T00:00:00.000Z'
    });
    const resolution = registry.resolve({ step: 'spec.author', schemaId: SPEC_AUTHOR_SCHEMA_ID });
    expect(resolution.status).toBe('resolved');
    if (resolution.status !== 'resolved') return;

    const parsed = resolution.contract.schema.parse({
      kind: 'feature_spec',
      slug: 'no-issue-stamping',
      relativePath: 'context-human/specs/feature-no-issue-stamping.md',
      frontmatter: {
        issue: 88
      },
      body: '# No issue stamping\n\nBody.'
    });

    expect(parsed.frontmatter.issue).toBeUndefined();
    expect(parsed.frontmatter.created).toBe('2026-06-17');
    expect(parsed.frontmatter.last_updated).toBe('2026-06-17');
    expect(parsed.frontmatter.status).toBe('draft');
  });

  it('leaves non-object result candidates on the normal schema failure path', () => {
    expect(stampSpecAuthorResultIdentity('not an object', {
      clock: () => '2026-06-17T00:00:00.000Z'
    })).toBe('not an object');
  });

  it('attaches the spec-author frontmatter normalizer by default', () => {
    const registry = registerSpecAuthorResultContract(createStepResultContractRegistry(), {
      clock: () => '2026-06-18T00:00:00.000Z'
    });
    const resolution = registry.resolve({ step: 'spec.author', schemaId: SPEC_AUTHOR_SCHEMA_ID });
    expect(resolution.status).toBe('resolved');
    if (resolution.status !== 'resolved') return;
    expect(Array.isArray(resolution.contract.normalizers)).toBe(true);
    expect((resolution.contract.normalizers as readonly { id: string }[])[0]?.id).toBe('spec-author-frontmatter-contract');
  });

  it('propagates spec-author correction and validation policy options', () => {
    const normalizer = { id: 'custom-spec-author', description: 'custom', normalize: () => ({ status: 'unchanged' as const }) };
    const correctionRequester = { requestCorrection: async () => ({}) };
    const registry = registerSpecAuthorResultContract(createStepResultContractRegistry(), {
      normalizers: [normalizer],
      correctionRequester,
      maxCorrectionAttempts: 1,
      degradationPolicy: { optionalPaths: [['frontmatter', 'implemented_by']] }
    });
    const resolution = registry.resolve({ step: 'spec.author', schemaId: SPEC_AUTHOR_SCHEMA_ID });
    expect(resolution.status).toBe('resolved');
    if (resolution.status !== 'resolved') return;
    expect(resolution.contract.normalizers).toEqual([normalizer]);
    expect(resolution.contract.correctionRequester).toBe(correctionRequester);
    expect(resolution.contract.maxCorrectionAttempts).toBe(1);
    expect(resolution.contract.degradationPolicy).toEqual({ optionalPaths: [['frontmatter', 'implemented_by']] });
  });
});

describe('pr.finalize result contract registration', () => {
  it('exports PR_FINALIZE_SCHEMA_ID as autocatalyst.pr_finalize.v1', () => {
    expect(PR_FINALIZE_SCHEMA_ID).toBe('autocatalyst.pr_finalize.v1');
  });

  it('registers a default pr.finalize contract with the null-strip and clean-result normalizers', () => {
    const registry = registerPullRequestFinalizeResultContract(createStepResultContractRegistry());
    const resolution = registry.resolve({ step: 'pr.finalize', schemaId: PR_FINALIZE_SCHEMA_ID });
    expect(resolution.status).toBe('resolved');
    if (resolution.status !== 'resolved') return;
    expect(resolution.contract.schema).toBe(prFinalizeResultSchema);
    const normalizers = resolution.contract.normalizers as readonly { id: string }[];
    expect(normalizers[0]?.id).toBe('pr-finalize-null-strip');
    expect(normalizers[1]?.id).toBe('pr-finalize-clean-result');
  });

  it('propagates PR-finalize policy and rejects duplicate registrations', () => {
    const correctionRequester = { requestCorrection: async () => ({ directive: 'advance', findings: [] }) };
    const registry = registerPullRequestFinalizeResultContract(createStepResultContractRegistry(), {
      correctionRequester,
      maxCorrectionAttempts: 1,
      degradationPolicy: { optionalPaths: [['titleSubject']] }
    });
    const resolution = registry.resolve({ step: 'pr.finalize', schemaId: PR_FINALIZE_SCHEMA_ID });
    expect(resolution.status).toBe('resolved');
    if (resolution.status !== 'resolved') return;
    expect(resolution.contract.correctionRequester).toBe(correctionRequester);
    expect(resolution.contract.maxCorrectionAttempts).toBe(1);
    expect(resolution.contract.degradationPolicy).toEqual({ optionalPaths: [['titleSubject']] });
    expect(() => registerPullRequestFinalizeResultContract(registry)).toThrow(/Duplicate step result contract/);
  });
});

describe('reviewer result contract registration', () => {
  it('exports REVIEWER_RESULT_SCHEMA_ID as autocatalyst.reviewer_result.v1', () => {
    expect(REVIEWER_RESULT_SCHEMA_ID).toBe('autocatalyst.reviewer_result.v1');
  });

  it('registers autocatalyst.reviewer_result.v1 for implementation.build', () => {
    const registry = registerReviewerResultContract(createStepResultContractRegistry());
    const resolution = registry.resolve({ step: 'implementation.build', schemaId: REVIEWER_RESULT_SCHEMA_ID });
    expect(resolution.status).toBe('resolved');
    if (resolution.status !== 'resolved') return;
    expect(resolution.contract.schemaId).toBe('autocatalyst.reviewer_result.v1');
    expect(resolution.contract.resultFile).toBe('step-result.json');
    const normalizers = resolution.contract.normalizers as readonly { id: string }[];
    expect(Array.isArray(normalizers)).toBe(true);
    expect(normalizers.map((n) => n.id)).toContain('reviewer-null-findings-strip');
    expect(normalizers.map((n) => n.id)).toContain('reviewer-result-clean-review');
  });

  it('rejects invalid reviewer result shapes', () => {
    const registry = registerReviewerResultContract(createStepResultContractRegistry());
    const resolution = registry.resolve({ step: 'implementation.build', schemaId: REVIEWER_RESULT_SCHEMA_ID });
    expect(resolution.status).toBe('resolved');
    if (resolution.status !== 'resolved') return;
    expect(() => resolution.contract.schema.parse({
      kind: 'feature_spec',
      slug: 'wrong-shape',
      relativePath: 'context-human/specs/feature-wrong-shape.md',
      frontmatter: { created: '2026-06-16', last_updated: '2026-06-16', status: 'draft', specced_by: 'autocatalyst' },
      body: '# Wrong shape'
    })).toThrow();
  });
});

describe('implementer dispositions result contract registration', () => {
  it('exports IMPLEMENTER_DISPOSITIONS_SCHEMA_ID as autocatalyst.implementer_dispositions.v1', () => {
    expect(IMPLEMENTER_DISPOSITIONS_SCHEMA_ID).toBe('autocatalyst.implementer_dispositions.v1');
  });

  it('registers the implementer dispositions contract for implementation.build', () => {
    const registry = registerImplementerDispositionsResultContract(createStepResultContractRegistry());
    const resolution = registry.resolve({ step: 'implementation.build', schemaId: IMPLEMENTER_DISPOSITIONS_SCHEMA_ID });
    expect(resolution.status).toBe('resolved');
    if (resolution.status !== 'resolved') return;
    expect(resolution.contract.schemaId).toBe('autocatalyst.implementer_dispositions.v1');
    const normalizers = resolution.contract.normalizers as readonly { id: string }[];
    expect(Array.isArray(normalizers)).toBe(true);
    expect(normalizers.map((n) => n.id)).toContain('implementer-dispositions-null-strip');
  });

  it('accepts an empty object and a dispositions array, and rejects a reviewer verdict', () => {
    const registry = registerImplementerDispositionsResultContract(createStepResultContractRegistry());
    const resolution = registry.resolve({ step: 'implementation.build', schemaId: IMPLEMENTER_DISPOSITIONS_SCHEMA_ID });
    if (resolution.status !== 'resolved') throw new Error('expected resolved contract');
    expect(resolution.contract.schema.parse({})).toEqual({});
    expect(resolution.contract.schema.parse({
      dispositions: [{ feedbackId: 'fb_1', disposition: 'fixed', summary: 'Done.' }]
    })).toMatchObject({ dispositions: [{ disposition: 'fixed' }] });
    expect(() => resolution.contract.schema.parse({ status: 'satisfied', findings: [] })).toThrow();
  });
});
