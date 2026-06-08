import { z } from 'zod';

import { nonModelPrincipalSchema } from './domain-value-objects.js';

function requireTenantMatchesOwner<T extends { owner: { tenantId: string }; tenant: string }>(value: T, context: z.RefinementCtx): void {
  if (value.tenant !== value.owner.tenantId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['tenant'], message: 'Tenant must match owner.tenantId.' });
  }
}

export const pullRequestStateSchema = z.enum(['open', 'merged', 'closed']);

export const pullRequestSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  owner: nonModelPrincipalSchema,
  tenant: z.string().min(1),
  provider: z.string().min(1),
  number: z.number().int().min(1),
  url: z.string().url(),
  state: pullRequestStateSchema,
  branch: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict().superRefine(requireTenantMatchesOwner);

export const createPullRequestInputSchema = z.object({
  runId: z.string().min(1),
  owner: nonModelPrincipalSchema,
  tenant: z.string().min(1),
  provider: z.string().min(1),
  number: z.number().int().min(1),
  url: z.string().url(),
  state: pullRequestStateSchema,
  branch: z.string().min(1)
}).strict().superRefine(requireTenantMatchesOwner);

export type PullRequestState = z.infer<typeof pullRequestStateSchema>;
export type PullRequest = z.infer<typeof pullRequestSchema>;
export type CreatePullRequestInput = z.infer<typeof createPullRequestInputSchema>;
