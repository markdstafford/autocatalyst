import { z } from 'zod';

import { UnsupportedProviderCapabilityError } from './agent-provider-adapter.js';
import type { StructuredAgentResultCaptureMechanism } from './structured-result-capture.js';

export type ProviderSchemaProjectionTarget = 'openai_agents_output_type' | 'claude_tool_input_schema';
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
    input.target === 'openai_agents_output_type' ? 'openai_output_type' : 'claude_submit_result_tool';

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

// reviewerResultSchema is a discriminatedUnion('status', [satisfied, findings])
// satisfied: { status: 'satisfied', findings?: [] }
// findings: { status: 'findings', findings: [{ externalId?, title, body, severity, anchor? }] }
// anchor is a discriminated union — flatten to optional string for provider projection
function buildReviewerResultProjection(_target: ProviderSchemaProjectionTarget): ProviderStructuredOutputSchema {
  return {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['satisfied', 'findings'] },
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            externalId: { type: 'string' },
            title: { type: 'string' },
            body: { type: 'string' },
            severity: { type: 'string', enum: ['blocker', 'warning', 'info'] }
          },
          required: ['title', 'body', 'severity'],
          additionalProperties: false
        }
      }
    },
    required: ['status'],
    additionalProperties: false
  };
}

// implementerDispositionsResultSchema: { dispositions?: Array<fixed | declined> }
// fixed: { feedbackId, disposition: 'fixed', summary }
// declined: { feedbackId, disposition: 'declined', reason }
function buildImplementerDispositionsProjection(_target: ProviderSchemaProjectionTarget): ProviderStructuredOutputSchema {
  return {
    type: 'object',
    properties: {
      dispositions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            feedbackId: { type: 'string' },
            disposition: { type: 'string', enum: ['fixed', 'declined'] },
            summary: { type: 'string' },
            reason: { type: 'string' }
          },
          required: ['feedbackId', 'disposition'],
          additionalProperties: false
        }
      }
    },
    additionalProperties: false
  };
}

// specAuthorResultSchema: { kind, slug, relativePath, frontmatter, body }
// frontmatter: { created, last_updated, status, issue?, specced_by, implemented_by?, supersedes?, superseded_by? }
// cross-field superRefine (relativePath ~ kind+slug) is enforced at execution boundary, not projected
function buildSpecAuthorProjection(_target: ProviderSchemaProjectionTarget): ProviderStructuredOutputSchema {
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

// prFinalizeResultSchema: { directive, reconciledSummary?, titleSubject?, validationSummary?, findings[] }
// prFinalizeFindingSchema: { severity, summary, target? }
// cross-field superRefine (advance + blocker contradiction) is enforced at execution boundary
function buildPrFinalizeProjection(_target: ProviderSchemaProjectionTarget): ProviderStructuredOutputSchema {
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
