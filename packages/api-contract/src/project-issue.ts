import { z } from 'zod';

import { trackedIssueStateSchema } from './domain-value-objects.js';
import { notFoundErrorCode } from './errors.js';
import { projectIdParamsSchema, projectResourcePath } from './project.js';
import { issueWorkKindSchema } from './run.js';

export const projectIssuePath = `${projectResourcePath}/issues/:number` as const;
export const lookupProjectIssueSuccessStatusCode = 200 as const;

const issueNumberSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const projectIssuePathParamsSchema = projectIdParamsSchema.extend({
  number: issueNumberSchema
});
export const projectIssueParamsSchema = projectIssuePathParamsSchema.extend({
  number: z.string().regex(/^[0-9]+$/u).transform(Number).pipe(issueNumberSchema)
});

export const issueSummarySchema = z.object({
  number: issueNumberSchema,
  title: z.string().min(1),
  url: z.string().url(),
  labels: z.array(z.string().min(1)),
  state: trackedIssueStateSchema
}).strict();

// OpenAPI 3.0 uses nullable plus a singleton enum to represent a null-only field.
const nullOnlyOpenApiSchema = { type: 'string' as const, nullable: true, enum: [null] };

export const issueWorkKindDerivationSchema = z.union([
  z.object({
    kind: issueWorkKindSchema,
    source: z.enum(['label', 'title_prefix'])
  }).strict(),
  z.object({
    kind: z.null().openapi(nullOnlyOpenApiSchema),
    source: z.literal('none'),
    reason: z.enum(['no_match', 'ambiguous_labels'])
  }).strict()
]);
export type IssueWorkKindDerivation = z.infer<typeof issueWorkKindDerivationSchema>;

export const projectIssueLookupResponseSchema = z.object({
  issue: issueSummarySchema,
  workKind: issueWorkKindDerivationSchema
}).strict();
export type ProjectIssueLookupResponse = z.infer<typeof projectIssueLookupResponseSchema>;

export const projectIssueNotFoundResponseSchema = z.object({
  error: z.object({
    code: z.literal(notFoundErrorCode),
    message: z.string().min(1),
    details: z.object({ resource: z.enum(['project', 'issue']) }).strict()
  }).strict()
}).strict();
