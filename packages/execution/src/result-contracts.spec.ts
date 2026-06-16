import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import {
  SPEC_AUTHOR_SCHEMA_ID,
  REVIEWER_RESULT_SCHEMA_ID,
  createStepResultContractRegistry,
  resolveStepResultContract,
  registerReviewerResultContract,
  registerSpecAuthorResultContract,
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
