import { TESTING_GUIDE_SCHEMA_ID } from '@autocatalyst/api-contract';
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
  readonly step?: string;
  readonly target: ProviderSchemaProjectionTarget;
}): ProviderSchemaProjection {
  const mechanism: StructuredAgentResultCaptureMechanism =
    input.target === 'openai_agents_output_type' ? 'openai_output_type' : 'claude_structured_output';

  const completed = buildProjectedSchema(input.schemaId, input.target, input.step);
  // The provider transport can also carry a question. Completed result contracts
  // stay unchanged and the adapter emits a runner pause instead of writing JSON.
  const schema = input.step === 'spec.author' &&
    (input.schemaId === 'autocatalyst.reviewer_result.v1' || input.schemaId === 'autocatalyst.reviewed_spec_author.v1')
    ? {
      type: 'object',
      properties: { response: { anyOf: [completed, {
        type: 'object', properties: { directive: { type: 'string', enum: ['needs_input'] }, question: { type: 'string' } },
        required: ['directive', 'question'], additionalProperties: false
      }] } },
      required: ['response'], additionalProperties: false
    } : completed;

  return {
    schemaId: input.schemaId,
    target: input.target,
    schema,
    mechanism
  };
}

function buildProjectedSchema(
  schemaId: string,
  target: ProviderSchemaProjectionTarget,
  step?: string
): ProviderStructuredOutputSchema {
  switch (schemaId) {
    case 'autocatalyst.reviewer_result.v1':
      return buildReviewerResultProjection(target, step === 'spec.author');
    case 'autocatalyst.reviewed_spec_author.v1':
      return {
        type: 'object',
        properties: {
          spec: buildSpecAuthorProjection(target),
          dispositions: dispositionArrayProjection()
        },
        required: ['spec', 'dispositions'],
        additionalProperties: false
      };
    case 'autocatalyst.implementer_dispositions.v1':
      return buildImplementerDispositionsProjection(target);
    case 'autocatalyst.spec_author.v1':
      return buildSpecAuthorProjection(target);
    case TESTING_GUIDE_SCHEMA_ID: {
      const strict = target === 'openai_agents_output_type';
      return {
        type: 'object',
        properties: {
          instructions: { type: 'string' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string' },
                expected: strict ? { type: ['string', 'null'] } : { type: 'string' }
              },
              required: strict ? ['text', 'expected'] : ['text'],
              additionalProperties: false
            }
          }
        },
        required: ['instructions', 'items'],
        additionalProperties: false
      };
    }
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
// Both provider transports require an object root. Branch-specific requirements
// (satisfied has no findings; findings has at least one) remain enforced by the
// canonical schema at result capture, before a result file or advance event.
// ---------------------------------------------------------------------------
function specFindingItem(target: ProviderSchemaProjectionTarget) {
  const strict = target === 'openai_agents_output_type';
  const base = strict ? strictFindingItem : claudeFindingItem;
  return { anyOf: [
    { ...base, properties: { ...base.properties, scope: { type: 'string', enum: ['document'] } }, required: [...base.required, 'scope'] },
    { ...base, properties: { ...base.properties, scope: { type: 'string', enum: ['passage'] },
      passageQuote: strict ? { anyOf: [{ type: 'string' }, { type: 'null' }] } : { type: 'string' } },
      required: [...base.required, 'scope', ...(strict ? ['passageQuote'] : [])] }
  ] };
}

function buildReviewerResultProjection(target: ProviderSchemaProjectionTarget, spec = false): ProviderStructuredOutputSchema {
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
            { type: 'array', items: spec ? specFindingItem(target) : strictFindingItem },
            { type: 'null' }
          ]
        }
      },
      required: ['status', 'findings'],
      additionalProperties: false
    };
  }

  // Claude's structured-output tool rejects root-level unions. Preserve branch
  // validation in the canonical schema at capture, after this transport projection.
  return {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['satisfied', 'findings'] },
      findings: { type: 'array', items: spec ? specFindingItem(target) : claudeFindingItem }
    },
    required: ['status'],
    additionalProperties: false
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
function dispositionArrayProjection() {
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

  return { type: 'array', items: { anyOf: [fixedItem, declinedItem] } };
}

function buildImplementerDispositionsProjection(target: ProviderSchemaProjectionTarget): ProviderStructuredOutputSchema {
  const dispositionsArray = dispositionArrayProjection();

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
