import { z } from 'zod';

import { nonModelPrincipalSchema, requireTenantMatchesOwner, testingGuideResultSchema, trackedIssueSchema } from './domain-value-objects.js';

export const runWorkKindSchema = z.string().min(1);

export const runSchema = z.object({
  id: z.string().min(1),
  topicId: z.string().min(1),
  owner: nonModelPrincipalSchema,
  tenant: z.string().min(1),
  workKind: runWorkKindSchema,
  currentStep: z.string().min(1),
  // Temporary persistence discriminator for the one-active-run partial index. ADR-015 will reconcile
  // terminality to the workflow step catalog's waiting_on-derived source of truth when that feature lands.
  terminal: z.boolean(),
  trackedIssue: trackedIssueSchema.optional(),
  testingGuideResult: testingGuideResultSchema.optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict().superRefine(requireTenantMatchesOwner);

export const createRunInputSchema = z.object({
  topicId: z.string().min(1),
  owner: nonModelPrincipalSchema,
  tenant: z.string().min(1),
  workKind: runWorkKindSchema,
  currentStep: z.string().min(1),
  // Temporary persistence discriminator for the one-active-run partial index. ADR-015 will reconcile
  // terminality to the workflow step catalog's waiting_on-derived source of truth when that feature lands.
  terminal: z.boolean(),
  trackedIssue: trackedIssueSchema.optional(),
  testingGuideResult: testingGuideResultSchema.optional()
}).strict().superRefine(requireTenantMatchesOwner);

export const runCollectionPath = '/v1/runs' as const;
export const runResourcePath = '/v1/runs/:id' as const;
export const getRunSuccessStatusCode = 200 as const;
export const listRunsSuccessStatusCode = 200 as const;

export const createRunWorkKindSchema = z.enum(['feature', 'enhancement', 'bug', 'chore', 'file_issue', 'question']);

export const runIdParamsSchema = z.object({ id: z.string().min(1) }).strict();

export const runListResponseSchema = z.object({
  runs: z.array(runSchema)
}).strict();

export type RunWorkKind = z.infer<typeof runWorkKindSchema>;
export type Run = z.infer<typeof runSchema>;
export type CreateRunInput = z.infer<typeof createRunInputSchema>;
export type CreateRunWorkKind = z.infer<typeof createRunWorkKindSchema>;
export type RunIdParams = z.infer<typeof runIdParamsSchema>;
export type RunListResponse = z.infer<typeof runListResponseSchema>;
