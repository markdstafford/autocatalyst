import { describe, expect, it } from 'vitest';
import { reviewerResultSchema, specReviewerResultSchema } from '@autocatalyst/api-contract';

import { createReviewedSpecAuthorResultContract, createSpecReviewerResultContract, REVIEWER_RESULT_SCHEMA_ID } from './result-contracts.js';
import { projectStepResultSchemaForProvider } from './provider-schema-projection.js';

const finding = { title: 'Scope', body: 'Clarify behavior.', severity: 'info' };
const result = (item: Record<string, unknown>) => ({ status: 'findings', findings: [{ ...finding, ...item }] });

describe('reviewed spec result contracts', () => {
  it('preserves exact quote whitespace and distinguishes an unlocated passage from a document concern', () => {
    const { schema } = createSpecReviewerResultContract();
    for (const quote of ['  exact\ntext  ', '   ', undefined]) {
      const input = result({ scope: 'passage', ...(quote !== undefined ? { passageQuote: quote } : {}) });
      expect(schema.parse(input)).toEqual(input);
    }
    expect(schema.safeParse(result({ scope: 'document' })).success).toBe(true);
    expect(schema.safeParse(result({ scope: 'document', passageQuote: '' })).success).toBe(false);
    expect(schema.safeParse(result({ scope: 'passage', anchor: { kind: 'artifact_range' } })).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ status: 'findings', findings: [] }).success).toBe(false);
  });

  it('keeps the build reviewer variant unchanged and projects spec capture by trusted step', () => {
    expect(reviewerResultSchema.safeParse(result({})).success).toBe(true);
    expect(specReviewerResultSchema.safeParse(result({})).success).toBe(false);
    const project = (step: string, schema: typeof reviewerResultSchema | typeof specReviewerResultSchema) => JSON.stringify(
      projectStepResultSchemaForProvider({ step, schema, schemaId: REVIEWER_RESULT_SCHEMA_ID, target: 'openai_agents_output_type' }).schema
    );
    expect(project('implementation.build', reviewerResultSchema)).not.toContain('passageQuote');
    expect(project('spec.author', specReviewerResultSchema)).toContain('passageQuote');
    expect(project('spec.author', specReviewerResultSchema)).not.toContain('"anchor"');
  });

  it('validates the nested system-stamped author spec and exact required dispositions', () => {
    const { schema } = createReviewedSpecAuthorResultContract({
      requiredFeedbackIds: ['fb-1'], kind: 'feature_spec', clock: () => '2026-11-22T00:00:00.000Z'
    });
    const spec = { kind: 'feature_spec', slug: 'review', relativePath: 'context-human/specs/feature-review.md', body: '# Spec', frontmatter: {} };
    const disposition = { feedbackId: 'fb-1', disposition: 'fixed', summary: 'Clarified behavior.' };
    expect(schema.parse({ spec, dispositions: [disposition] })).toMatchObject({
      spec: { frontmatter: { created: '2026-11-22', status: 'draft', specced_by: 'autocatalyst' } }
    });
    for (const dispositions of [[], [disposition, disposition], [{ ...disposition, feedbackId: 'unrelated' }], [{ ...disposition, summary: '  ' }]]) {
      expect(schema.safeParse({ spec, dispositions }).success).toBe(false);
    }
    expect(schema.safeParse(spec).success).toBe(false);
  });
});
