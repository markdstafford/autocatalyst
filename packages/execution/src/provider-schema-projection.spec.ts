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

// ---------------------------------------------------------------------------
// OpenAI strict-mode compatibility helper (INIT-1)
//
// Recursively verifies that every object schema with properties lists all of
// its properties in required and sets additionalProperties: false, which are
// the two invariants required by OpenAI structured output strict mode.
// ---------------------------------------------------------------------------
type JsonSchema = Record<string, unknown>;

function collectStrictViolations(schema: unknown, path: string, violations: string[]): void {
  if (typeof schema !== 'object' || schema === null) return;
  const obj = schema as JsonSchema;

  if (obj['type'] === 'object' && typeof obj['properties'] === 'object' && obj['properties'] !== null) {
    const props = Object.keys(obj['properties'] as object);
    const required: string[] = Array.isArray(obj['required']) ? (obj['required'] as string[]) : [];
    const missing = props.filter((p) => !required.includes(p));
    if (missing.length > 0) {
      violations.push(`${path}: properties not in required: [${missing.join(', ')}]`);
    }
    if (obj['additionalProperties'] !== false) {
      violations.push(`${path}: additionalProperties is not false`);
    }
    for (const [key, value] of Object.entries(obj['properties'] as object)) {
      collectStrictViolations(value, `${path}.properties.${key}`, violations);
    }
  }

  // Recurse into anyOf / oneOf branches
  for (const keyword of ['anyOf', 'oneOf', 'allOf']) {
    if (Array.isArray(obj[keyword])) {
      (obj[keyword] as unknown[]).forEach((branch, i) => {
        collectStrictViolations(branch, `${path}.${keyword}[${i}]`, violations);
      });
    }
  }

  // Recurse into array items
  if (typeof obj['items'] === 'object' && obj['items'] !== null) {
    collectStrictViolations(obj['items'], `${path}.items`, violations);
  }
}

function assertOpenAIStrictCompatible(schema: unknown, schemaId: string): void {
  const violations: string[] = [];
  collectStrictViolations(schema, `[${schemaId}]`, violations);
  expect(violations).toEqual([]);
}

// ---------------------------------------------------------------------------
// Basic projection shape
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// INIT-1: OpenAI strict JSON schema compatibility
//
// OpenAI structured output strict mode requires:
//   1. Every object schema's properties are all listed in required.
//   2. additionalProperties: false on every object schema.
// Optional fields must be nullable (anyOf with null branch), not simply absent
// from required. Violations cause the OpenAI backend to reject the schema.
// ---------------------------------------------------------------------------

describe('OpenAI strict mode compatibility (INIT-1)', () => {
  for (const schemaId of coveredSchemaIds) {
    it(`${schemaId}: openai_agents_output_type projection is strict-mode compatible`, () => {
      const projection = projectStepResultSchemaForProvider({
        schemaId,
        schema: schemaFixtures[schemaId],
        target: 'openai_agents_output_type'
      });
      assertOpenAIStrictCompatible(projection.schema, schemaId);
    });
  }
});

// ---------------------------------------------------------------------------
// INIT-2: Discriminated union branch constraints
//
// The canonical schemas enforce branch-specific requirements that the provider
// projection must also represent, so the provider cannot accept payloads the
// execution boundary will later reject.
// ---------------------------------------------------------------------------

describe('discriminated union branch constraints (INIT-2)', () => {
  describe('autocatalyst.reviewer_result.v1', () => {
    it('openai projection has a branch with status: findings and minItems: 1', () => {
      const projection = projectStepResultSchemaForProvider({
        schemaId: 'autocatalyst.reviewer_result.v1',
        schema: reviewerResultSchema,
        target: 'openai_agents_output_type'
      });
      const schema = projection.schema as JsonSchema;
      const branches = (schema['anyOf'] as JsonSchema[]) ?? [];
      const findingsBranch = branches.find(
        (b) => {
          const statusProp = (b['properties'] as JsonSchema | undefined)?.['status'];
          return (statusProp as JsonSchema | undefined)?.['enum']?.[0] === 'findings';
        }
      );
      expect(findingsBranch).toBeDefined();
      const findingsProp = (findingsBranch?.['properties'] as JsonSchema | undefined)?.['findings'] as JsonSchema | undefined;
      expect(findingsProp?.['minItems']).toBe(1);
    });

    it('openai projection has a branch with status: satisfied that does not allow non-empty findings', () => {
      const projection = projectStepResultSchemaForProvider({
        schemaId: 'autocatalyst.reviewer_result.v1',
        schema: reviewerResultSchema,
        target: 'openai_agents_output_type'
      });
      const schema = projection.schema as JsonSchema;
      const branches = (schema['anyOf'] as JsonSchema[]) ?? [];
      const satisfiedBranch = branches.find(
        (b) => {
          const statusProp = (b['properties'] as JsonSchema | undefined)?.['status'];
          return (statusProp as JsonSchema | undefined)?.['enum']?.[0] === 'satisfied';
        }
      );
      expect(satisfiedBranch).toBeDefined();
      // findings for satisfied branch must constrain to empty/null — verified by maxItems: 0
      const findingsProp = (satisfiedBranch?.['properties'] as JsonSchema | undefined)?.['findings'] as JsonSchema | undefined;
      // findings is anyOf with one branch having maxItems: 0 and one being null
      const anyOfBranches = (findingsProp?.['anyOf'] as JsonSchema[] | undefined) ?? [];
      const hasMaxItems = anyOfBranches.some((b) => (b as JsonSchema)['maxItems'] === 0);
      expect(hasMaxItems).toBe(true);
    });

    it('claude projection has a branch with status: findings and minItems: 1', () => {
      const projection = projectStepResultSchemaForProvider({
        schemaId: 'autocatalyst.reviewer_result.v1',
        schema: reviewerResultSchema,
        target: 'claude_tool_input_schema'
      });
      const schema = projection.schema as JsonSchema;
      const branches = (schema['anyOf'] as JsonSchema[]) ?? [];
      const findingsBranch = branches.find(
        (b) => {
          const statusProp = (b['properties'] as JsonSchema | undefined)?.['status'];
          return (statusProp as JsonSchema | undefined)?.['enum']?.[0] === 'findings';
        }
      );
      expect(findingsBranch).toBeDefined();
      const findingsProp = (findingsBranch?.['properties'] as JsonSchema | undefined)?.['findings'] as JsonSchema | undefined;
      expect(findingsProp?.['minItems']).toBe(1);
    });

    it('near-miss: findings status branch requires non-empty findings (structural check)', () => {
      // Verify the projected schema structure rejects { status: 'findings', findings: [] }
      // by confirming the findings branch enforces minItems: 1.
      for (const target of ['openai_agents_output_type', 'claude_tool_input_schema'] as const) {
        const projection = projectStepResultSchemaForProvider({
          schemaId: 'autocatalyst.reviewer_result.v1',
          schema: reviewerResultSchema,
          target
        });
        const schema = projection.schema as JsonSchema;
        const branches = (schema['anyOf'] as JsonSchema[]) ?? [];
        // Every branch that allows status: 'findings' must have minItems: 1 on findings
        const findingsBranches = branches.filter((b) => {
          const statusEnum = ((b['properties'] as JsonSchema | undefined)?.['status'] as JsonSchema | undefined)?.['enum'];
          return Array.isArray(statusEnum) && statusEnum.includes('findings') && !statusEnum.includes('satisfied');
        });
        expect(findingsBranches.length).toBeGreaterThan(0);
        for (const branch of findingsBranches) {
          const findings = (branch['properties'] as JsonSchema | undefined)?.['findings'] as JsonSchema | undefined;
          expect(findings?.['minItems']).toBeGreaterThanOrEqual(1);
        }
      }
    });
  });

  describe('autocatalyst.implementer_dispositions.v1', () => {
    it('openai projection item branches require summary for fixed and reason for declined', () => {
      const projection = projectStepResultSchemaForProvider({
        schemaId: 'autocatalyst.implementer_dispositions.v1',
        schema: implementerDispositionsResultSchema,
        target: 'openai_agents_output_type'
      });
      const schema = projection.schema as JsonSchema;
      // dispositions is anyOf [array, null] for openai strict
      const dispositionsProp = (schema['properties'] as JsonSchema | undefined)?.['dispositions'] as JsonSchema | undefined;
      const anyOfBranches = (dispositionsProp?.['anyOf'] as JsonSchema[] | undefined) ?? [];
      const arrayBranch = anyOfBranches.find((b) => (b as JsonSchema)['type'] === 'array') as JsonSchema | undefined;
      const itemSchema = arrayBranch?.['items'] as JsonSchema | undefined;
      const itemBranches = (itemSchema?.['anyOf'] as JsonSchema[] | undefined) ?? [];

      const fixedBranch = itemBranches.find((b) => {
        const dispEnum = ((b['properties'] as JsonSchema | undefined)?.['disposition'] as JsonSchema | undefined)?.['enum'];
        return Array.isArray(dispEnum) && dispEnum.includes('fixed');
      });
      const declinedBranch = itemBranches.find((b) => {
        const dispEnum = ((b['properties'] as JsonSchema | undefined)?.['disposition'] as JsonSchema | undefined)?.['enum'];
        return Array.isArray(dispEnum) && dispEnum.includes('declined');
      });

      expect(fixedBranch).toBeDefined();
      expect(declinedBranch).toBeDefined();
      expect((fixedBranch?.['required'] as string[] | undefined)?.includes('summary')).toBe(true);
      expect((declinedBranch?.['required'] as string[] | undefined)?.includes('reason')).toBe(true);
      // fixed branch must NOT require reason; declined branch must NOT require summary
      expect((fixedBranch?.['required'] as string[] | undefined)?.includes('reason')).toBe(false);
      expect((declinedBranch?.['required'] as string[] | undefined)?.includes('summary')).toBe(false);
    });

    it('claude projection item branches require summary for fixed and reason for declined', () => {
      const projection = projectStepResultSchemaForProvider({
        schemaId: 'autocatalyst.implementer_dispositions.v1',
        schema: implementerDispositionsResultSchema,
        target: 'claude_tool_input_schema'
      });
      const schema = projection.schema as JsonSchema;
      const dispositionsProp = (schema['properties'] as JsonSchema | undefined)?.['dispositions'] as JsonSchema | undefined;
      const itemSchema = dispositionsProp?.['items'] as JsonSchema | undefined;
      const itemBranches = (itemSchema?.['anyOf'] as JsonSchema[] | undefined) ?? [];

      const fixedBranch = itemBranches.find((b) => {
        const dispEnum = ((b['properties'] as JsonSchema | undefined)?.['disposition'] as JsonSchema | undefined)?.['enum'];
        return Array.isArray(dispEnum) && dispEnum.includes('fixed');
      });
      const declinedBranch = itemBranches.find((b) => {
        const dispEnum = ((b['properties'] as JsonSchema | undefined)?.['disposition'] as JsonSchema | undefined)?.['enum'];
        return Array.isArray(dispEnum) && dispEnum.includes('declined');
      });

      expect(fixedBranch).toBeDefined();
      expect(declinedBranch).toBeDefined();
      expect((fixedBranch?.['required'] as string[] | undefined)?.includes('summary')).toBe(true);
      expect((declinedBranch?.['required'] as string[] | undefined)?.includes('reason')).toBe(true);
    });

    it('near-miss: fixed disposition without summary is rejected by schema structure', () => {
      // Verify no branch allows fixed disposition without summary in required
      for (const target of ['openai_agents_output_type', 'claude_tool_input_schema'] as const) {
        const projection = projectStepResultSchemaForProvider({
          schemaId: 'autocatalyst.implementer_dispositions.v1',
          schema: implementerDispositionsResultSchema,
          target
        });
        const schema = projection.schema as JsonSchema;
        // Find the array items via either path (strict: anyOf[array].items, non-strict: direct)
        let itemBranches: JsonSchema[] = [];
        const dispositionsProp = (schema['properties'] as JsonSchema | undefined)?.['dispositions'] as JsonSchema | undefined;
        if (Array.isArray(dispositionsProp?.['anyOf'])) {
          const arrayBranch = (dispositionsProp!['anyOf'] as JsonSchema[]).find((b) => b['type'] === 'array');
          itemBranches = (arrayBranch?.['items'] as JsonSchema | undefined)?.['anyOf'] as JsonSchema[] ?? [];
        } else {
          itemBranches = (dispositionsProp?.['items'] as JsonSchema | undefined)?.['anyOf'] as JsonSchema[] ?? [];
        }

        // No item branch should allow 'fixed' disposition without requiring 'summary'
        const fixedWithoutSummary = itemBranches.find((b) => {
          const dispEnum = ((b['properties'] as JsonSchema | undefined)?.['disposition'] as JsonSchema | undefined)?.['enum'];
          const required = b['required'] as string[] | undefined;
          return Array.isArray(dispEnum) && dispEnum.includes('fixed') && !required?.includes('summary');
        });
        expect(fixedWithoutSummary).toBeUndefined();
      }
    });
  });

  describe('autocatalyst.spec_author.v1', () => {
    it('openai projection has all top-level properties in required', () => {
      const projection = projectStepResultSchemaForProvider({
        schemaId: 'autocatalyst.spec_author.v1',
        schema: specAuthorResultSchema,
        target: 'openai_agents_output_type'
      });
      const schema = projection.schema as JsonSchema;
      const props = Object.keys((schema['properties'] as object) ?? {});
      const required = schema['required'] as string[] ?? [];
      expect(props.sort()).toEqual(required.sort());
    });

    it('openai projection frontmatter has all fields in required (optional ones nullable)', () => {
      const projection = projectStepResultSchemaForProvider({
        schemaId: 'autocatalyst.spec_author.v1',
        schema: specAuthorResultSchema,
        target: 'openai_agents_output_type'
      });
      const schema = projection.schema as JsonSchema;
      const frontmatter = (schema['properties'] as JsonSchema | undefined)?.['frontmatter'] as JsonSchema | undefined;
      const fmProps = Object.keys((frontmatter?.['properties'] as object) ?? {});
      const fmRequired = (frontmatter?.['required'] as string[]) ?? [];
      expect(fmProps.sort()).toEqual(fmRequired.sort());
    });
  });

  describe('autocatalyst.pr_finalize.v1', () => {
    it('openai projection has all top-level properties in required', () => {
      const projection = projectStepResultSchemaForProvider({
        schemaId: 'autocatalyst.pr_finalize.v1',
        schema: prFinalizeResultSchema,
        target: 'openai_agents_output_type'
      });
      const schema = projection.schema as JsonSchema;
      const props = Object.keys((schema['properties'] as object) ?? {});
      const required = schema['required'] as string[] ?? [];
      expect(props.sort()).toEqual(required.sort());
    });

    it('openai projection finding items have all fields in required (target nullable)', () => {
      const projection = projectStepResultSchemaForProvider({
        schemaId: 'autocatalyst.pr_finalize.v1',
        schema: prFinalizeResultSchema,
        target: 'openai_agents_output_type'
      });
      const schema = projection.schema as JsonSchema;
      const findings = (schema['properties'] as JsonSchema | undefined)?.['findings'] as JsonSchema | undefined;
      const itemSchema = findings?.['items'] as JsonSchema | undefined;
      const itemProps = Object.keys((itemSchema?.['properties'] as object) ?? {});
      const itemRequired = (itemSchema?.['required'] as string[]) ?? [];
      expect(itemProps.sort()).toEqual(itemRequired.sort());
    });
  });
});
