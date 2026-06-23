import { z } from 'zod';

import { UnsupportedProviderCapabilityError } from './agent-provider-adapter.js';
import type { StructuredAgentResultCaptureMechanism } from './structured-result-capture.js';

export type ProviderSchemaProjectionTarget = 'openai_agents_output_type' | 'claude_output_format';
export type ProviderStructuredOutputSchema = unknown;

export interface ProviderSchemaProjection {
  readonly schemaId: string;
  readonly target: ProviderSchemaProjectionTarget;
  readonly schema: ProviderStructuredOutputSchema;
  readonly mechanism: StructuredAgentResultCaptureMechanism;
}

export class ProviderSchemaProjectionError extends UnsupportedProviderCapabilityError {
  override readonly code: 'structured_result_unsupported';
  readonly schemaId: string;
  readonly target: ProviderSchemaProjectionTarget;
  override readonly safeDetails?: unknown;

  constructor(schemaId: string, target: ProviderSchemaProjectionTarget, message: string, safeDetails?: unknown) {
    super('structured_result_unsupported', message, safeDetails);
    this.name = 'ProviderSchemaProjectionError';
    this.code = 'structured_result_unsupported';
    this.schemaId = schemaId;
    this.target = target;
    this.safeDetails = safeDetails;
  }
}

export function projectStepResultSchemaForProvider(input: {
  readonly schemaId: string;
  readonly schema: z.ZodTypeAny;
  readonly target: ProviderSchemaProjectionTarget;
}): ProviderSchemaProjection {
  const mechanism: StructuredAgentResultCaptureMechanism =
    input.target === 'openai_agents_output_type' ? 'openai_output_type' : 'claude_structured_output';

  const schema = buildProjectedSchema(input.schemaId, input.target);

  return {
    schemaId: input.schemaId,
    target: input.target,
    schema,
    mechanism
  };
}

function buildProjectedSchema(
  schemaId: string,
  target: ProviderSchemaProjectionTarget
): ProviderStructuredOutputSchema {
  switch (schemaId) {
    case 'autocatalyst.reviewer_result.v1':
      return buildReviewerResultProjection(target);
    case 'autocatalyst.implementer_dispositions.v1':
      return buildImplementerDispositionsProjection(target);
    case 'autocatalyst.spec_author.v1':
      return buildSpecAuthorProjection(target);
    case 'autocatalyst.pr_finalize.v1':
      return buildPrFinalizeProjection(target);
    default:
      throw new ProviderSchemaProjectionError(
        schemaId,
        target,
        `Schema id '${schemaId}' is not supported for provider projection.`,
        { schemaId, target }
      );
  }
}

// ---------------------------------------------------------------------------
// Finding item schemas (shared across targets)
// ---------------------------------------------------------------------------

// OpenAI strict finding item: all properties in required, externalId nullable.
// anchor is a complex discriminated union; it is omitted from the provider
// projection — the execution-boundary parse enforces it after capture.
const strictFindingItem = {
  type: 'object',
  properties: {
    externalId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    title: { type: 'string' },
    body: { type: 'string' },
    severity: { type: 'string', enum: ['blocker', 'warning', 'info'] }
  },
  required: ['externalId', 'title', 'body', 'severity'],
  additionalProperties: false
};

// Claude finding item: optional externalId, anchor omitted.
const claudeFindingItem = {
  type: 'object',
  properties: {
    externalId: { type: 'string' },
    title: { type: 'string' },
    body: { type: 'string' },
    severity: { type: 'string', enum: ['blocker', 'warning', 'info'] }
  },
  required: ['title', 'body', 'severity'],
  additionalProperties: false
};

// ---------------------------------------------------------------------------
// reviewerResultSchema projection
//
// Canonical: discriminatedUnion('status', [
//   satisfiedReviewerResultSchema: { status: 'satisfied', findings?: [] }
//   findingsReviewerResultSchema:  { status: 'findings',  findings: [min 1] }
// ])
//
// Provider projection uses anyOf with two branches so the provider can enforce:
//   - 'satisfied' branch: findings absent/null/empty
//   - 'findings' branch: non-empty findings array required
// This addresses the weakening flagged in INIT-2.
// ---------------------------------------------------------------------------
function buildReviewerResultProjection(target: ProviderSchemaProjectionTarget): ProviderStructuredOutputSchema {
  if (target === 'openai_agents_output_type') {
    // OpenAI strict mode requires type: 'object' at the root — bare anyOf is rejected by the SDK.
    // Discriminated union enforcement (satisfied requires no findings, findings requires non-empty)
    // is handled at the execution boundary via the canonical Zod schema.
    return {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['satisfied', 'findings'] },
        findings: {
          anyOf: [
            { type: 'array', items: strictFindingItem },
            { type: 'null' }
          ]
        }
      },
      required: ['status', 'findings'],
      additionalProperties: false
    };
  }

  // Claude target: not strict mode, but still enforce discriminated branches.
  return {
    anyOf: [
      {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['satisfied'] },
          findings: { type: 'array', items: claudeFindingItem, maxItems: 0 }
        },
        required: ['status'],
        additionalProperties: false
      },
      {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['findings'] },
          findings: { type: 'array', items: claudeFindingItem, minItems: 1 }
        },
        required: ['status', 'findings'],
        additionalProperties: false
      }
    ]
  };
}

// ---------------------------------------------------------------------------
// implementerDispositionsResultSchema projection
//
// Canonical: { dispositions?: Array<fixed | declined> }
//   fixed:   { feedbackId, disposition: 'fixed',   summary }
//   declined: { feedbackId, disposition: 'declined', reason }
//
// Provider projection uses anyOf within disposition items so the provider
// enforces branch-specific required fields (summary for fixed, reason for
// declined). This addresses the weakening flagged in INIT-2.
// ---------------------------------------------------------------------------
function buildImplementerDispositionsProjection(target: ProviderSchemaProjectionTarget): ProviderStructuredOutputSchema {
  const fixedItem = {
    type: 'object',
    properties: {
      feedbackId: { type: 'string' },
      disposition: { type: 'string', enum: ['fixed'] },
      summary: { type: 'string' }
    },
    required: ['feedbackId', 'disposition', 'summary'],
    additionalProperties: false
  };

  const declinedItem = {
    type: 'object',
    properties: {
      feedbackId: { type: 'string' },
      disposition: { type: 'string', enum: ['declined'] },
      reason: { type: 'string' }
    },
    required: ['feedbackId', 'disposition', 'reason'],
    additionalProperties: false
  };

  const dispositionsArray = {
    type: 'array',
    items: { anyOf: [fixedItem, declinedItem] }
  };

  if (target === 'openai_agents_output_type') {
    // OpenAI strict mode: dispositions in required, nullable because the canonical
    // schema marks it optional (implementer may have no dispositions this round).
    return {
      type: 'object',
      properties: {
        dispositions: {
          anyOf: [dispositionsArray, { type: 'null' }]
        }
      },
      required: ['dispositions'],
      additionalProperties: false
    };
  }

  // Claude target: dispositions is genuinely optional.
  return {
    type: 'object',
    properties: {
      dispositions: dispositionsArray
    },
    additionalProperties: false
  };
}

// ---------------------------------------------------------------------------
// specAuthorResultSchema projection
//
// Canonical: { kind, slug, relativePath, frontmatter, body }
// frontmatter: { created, last_updated, status, issue?, specced_by,
//                implemented_by?, supersedes?, superseded_by? }
//
// Cross-field superRefine (relativePath ~ kind+slug) is enforced at execution
// boundary, not projected — projection support does not fail for this.
// ---------------------------------------------------------------------------
function buildSpecAuthorProjection(target: ProviderSchemaProjectionTarget): ProviderStructuredOutputSchema {
  if (target === 'openai_agents_output_type') {
    // OpenAI strict mode: all frontmatter fields in required, optional ones nullable.
    return {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['feature_spec', 'enhancement_spec'] },
        slug: { type: 'string' },
        relativePath: { type: 'string' },
        frontmatter: {
          type: 'object',
          properties: {
            created: { type: 'string' },
            last_updated: { type: 'string' },
            status: { type: 'string', enum: ['draft', 'approved', 'implementing', 'complete', 'superseded'] },
            issue: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
            specced_by: { type: 'string' },
            implemented_by: { anyOf: [{ type: 'string' }, { type: 'null' }] },
            supersedes: { anyOf: [{ type: 'string' }, { type: 'null' }] },
            superseded_by: { anyOf: [{ type: 'string' }, { type: 'null' }] }
          },
          required: ['created', 'last_updated', 'status', 'issue', 'specced_by', 'implemented_by', 'supersedes', 'superseded_by'],
          additionalProperties: false
        },
        body: { type: 'string' }
      },
      required: ['kind', 'slug', 'relativePath', 'frontmatter', 'body'],
      additionalProperties: false
    };
  }

  // Claude target: optional frontmatter fields remain optional.
  return {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['feature_spec', 'enhancement_spec'] },
      slug: { type: 'string' },
      relativePath: { type: 'string' },
      frontmatter: {
        type: 'object',
        properties: {
          created: { type: 'string' },
          last_updated: { type: 'string' },
          status: { type: 'string', enum: ['draft', 'approved', 'implementing', 'complete', 'superseded'] },
          issue: { type: 'integer' },
          specced_by: { type: 'string' },
          implemented_by: { type: 'string' },
          supersedes: { type: 'string' },
          superseded_by: { type: 'string' }
        },
        required: ['created', 'last_updated', 'status', 'specced_by'],
        additionalProperties: false
      },
      body: { type: 'string' }
    },
    required: ['kind', 'slug', 'relativePath', 'frontmatter', 'body'],
    additionalProperties: false
  };
}

// ---------------------------------------------------------------------------
// prFinalizeResultSchema projection
//
// Canonical: { directive, reconciledSummary?, titleSubject?,
//              validationSummary?, findings[] }
// prFinalizeFinding: { severity, summary, target? }
//
// Cross-field superRefine (advance + blocker contradiction) is enforced at
// execution boundary, not projected.
// ---------------------------------------------------------------------------
function buildPrFinalizeProjection(target: ProviderSchemaProjectionTarget): ProviderStructuredOutputSchema {
  if (target === 'openai_agents_output_type') {
    // OpenAI strict mode: all properties in required, optional fields nullable.
    return {
      type: 'object',
      properties: {
        directive: { type: 'string', enum: ['advance', 'revise'] },
        reconciledSummary: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        titleSubject: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        validationSummary: {
          anyOf: [
            { type: 'array', items: { type: 'string' } },
            { type: 'null' }
          ]
        },
        findings: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              severity: { type: 'string', enum: ['blocker', 'warning', 'info'] },
              summary: { type: 'string' },
              target: { anyOf: [{ type: 'string' }, { type: 'null' }] }
            },
            required: ['severity', 'summary', 'target'],
            additionalProperties: false
          }
        }
      },
      required: ['directive', 'reconciledSummary', 'titleSubject', 'validationSummary', 'findings'],
      additionalProperties: false
    };
  }

  // Claude target: optional fields remain optional.
  return {
    type: 'object',
    properties: {
      directive: { type: 'string', enum: ['advance', 'revise'] },
      reconciledSummary: { type: 'string' },
      titleSubject: { type: 'string' },
      validationSummary: {
        type: 'array',
        items: { type: 'string' }
      },
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            severity: { type: 'string', enum: ['blocker', 'warning', 'info'] },
            summary: { type: 'string' },
            target: { type: 'string' }
          },
          required: ['severity', 'summary'],
          additionalProperties: false
        }
      }
    },
    required: ['directive', 'findings'],
    additionalProperties: false
  };
}
