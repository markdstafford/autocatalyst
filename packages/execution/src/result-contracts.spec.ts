import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { specAuthorResultSchema } from '@autocatalyst/api-contract';
import {
  createStepResultContractRegistry,
  resolveStepResultContract,
  registerSpecAuthorResultContract,
  SPEC_AUTHOR_SCHEMA_ID
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
    expect(resolution.contract.schema).toBe(specAuthorResultSchema);
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
});
