import { z } from 'zod';

import { nonModelPrincipalSchema, requireTenantMatchesOwner } from './domain-value-objects.js';

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
