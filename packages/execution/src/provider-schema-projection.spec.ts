import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import {
  reviewerResultSchema,
  implementerDispositionsResultSchema,
  specAuthorResultSchema,
  prFinalizeResultSchema
} from '@autocatalyst/api-contract';

import {
  projectStepResultSchemaForProvider,
  ProviderSchemaProjectionError
} from './provider-schema-projection.js';
import { UnsupportedProviderCapabilityError } from './agent-provider-adapter.js';

const coveredSchemaIds = [
  'autocatalyst.spec_author.v1',
  'autocatalyst.implementer_dispositions.v1',
  'autocatalyst.reviewer_result.v1',
  'autocatalyst.pr_finalize.v1'
] as const;

const schemaFixtures: Record<string, z.ZodTypeAny> = {
  'autocatalyst.spec_author.v1': specAuthorResultSchema,
  'autocatalyst.implementer_dispositions.v1': implementerDispositionsResultSchema,
  'autocatalyst.reviewer_result.v1': reviewerResultSchema,
  'autocatalyst.pr_finalize.v1': prFinalizeResultSchema
};

describe('projectStepResultSchemaForProvider', () => {
  describe('covered schema ids — openai_agents_output_type target', () => {
    for (const schemaId of coveredSchemaIds) {
      it(`projects ${schemaId} to openai_agents_output_type`, () => {
        const projection = projectStepResultSchemaForProvider({
          schemaId,
          schema: schemaFixtures[schemaId],
          target: 'openai_agents_output_type'
        });

        expect(projection.target).toBe('openai_agents_output_type');
        expect(projection.mechanism).toBe('openai_output_type');
        expect(projection.schemaId).toBe(schemaId);
        expect(projection.schema).toBeDefined();
        expect(projection.schema).not.toBeNull();
      });
    }
  });

  describe('covered schema ids — claude_tool_input_schema target', () => {
    for (const schemaId of coveredSchemaIds) {
      it(`projects ${schemaId} to claude_tool_input_schema`, () => {
        const projection = projectStepResultSchemaForProvider({
          schemaId,
          schema: schemaFixtures[schemaId],
          target: 'claude_tool_input_schema'
        });

        expect(projection.target).toBe('claude_tool_input_schema');
        expect(projection.mechanism).toBe('claude_submit_result_tool');
        expect(projection.schemaId).toBe(schemaId);
        expect(projection.schema).toBeDefined();
        expect(projection.schema).not.toBeNull();
      });
    }
  });

  it('throws ProviderSchemaProjectionError for unknown schema id', () => {
    const schema = z.object({ value: z.string() });
    expect(() =>
      projectStepResultSchemaForProvider({
        schemaId: 'custom.unregistered.v1',
        schema,
        target: 'openai_agents_output_type'
      })
    ).toThrow(ProviderSchemaProjectionError);
  });

  it('unknown schema error is a UnsupportedProviderCapabilityError', () => {
    const schema = z.object({ value: z.string() });
    expect(() =>
      projectStepResultSchemaForProvider({
        schemaId: 'custom.unregistered.v1',
        schema,
        target: 'openai_agents_output_type'
      })
    ).toThrow(UnsupportedProviderCapabilityError);
  });

  it('unknown schema error has code structured_result_unsupported', () => {
    const schema = z.object({ value: z.string() });
    let err: ProviderSchemaProjectionError | undefined;
    try {
      projectStepResultSchemaForProvider({
        schemaId: 'custom.unregistered.v1',
        schema,
        target: 'openai_agents_output_type'
      });
    } catch (e) {
      err = e as ProviderSchemaProjectionError;
    }
    expect(err?.code).toBe('structured_result_unsupported');
    // Safe details should not contain raw schema internals or absolute paths
    const serialized = JSON.stringify(err?.safeDetails ?? {});
    expect(serialized).not.toContain('/Users/');
    expect(serialized).not.toContain('ZodObject');
  });
});
