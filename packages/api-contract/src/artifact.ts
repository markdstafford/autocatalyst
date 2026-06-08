import { z } from 'zod';

import { nonModelPrincipalSchema, trackedIssueSchema } from './domain-value-objects.js';

function requireTenantMatchesOwner<T extends { owner: { tenantId: string }; tenant: string }>(value: T, context: z.RefinementCtx): void {
  if (value.tenant !== value.owner.tenantId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['tenant'], message: 'Tenant must match owner.tenantId.' });
  }
}

export const artifactKindSchema = z.enum(['feature_spec', 'enhancement_spec', 'bug_triage', 'chore_plan']);
export const artifactCachedStatusSchema = z.enum(['draft', 'ready_for_review', 'approved', 'published', 'superseded', 'unknown']);
export const artifactCanonicalRecordSchema = z.enum(['file', 'issue', 'other', 'none']);

export const artifactSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  owner: nonModelPrincipalSchema,
  tenant: z.string().min(1),
  kind: artifactKindSchema,
  canonicalRecord: artifactCanonicalRecordSchema,
  location: z.string().min(1),
  cachedStatus: artifactCachedStatusSchema,
  linkedIssue: trackedIssueSchema.optional(),
  publicationRefs: z.array(z.string().min(1)),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict().superRefine(requireTenantMatchesOwner);

export const createArtifactInputSchema = z.object({
  runId: z.string().min(1),
  owner: nonModelPrincipalSchema,
  tenant: z.string().min(1),
  kind: artifactKindSchema,
  canonicalRecord: artifactCanonicalRecordSchema,
  location: z.string().min(1),
  cachedStatus: artifactCachedStatusSchema,
  linkedIssue: trackedIssueSchema.optional(),
  publicationRefs: z.array(z.string().min(1))
}).strict().superRefine(requireTenantMatchesOwner);

export type ArtifactKind = z.infer<typeof artifactKindSchema>;
export type ArtifactCachedStatus = z.infer<typeof artifactCachedStatusSchema>;
export type Artifact = z.infer<typeof artifactSchema>;
export type CreateArtifactInput = z.infer<typeof createArtifactInputSchema>;
