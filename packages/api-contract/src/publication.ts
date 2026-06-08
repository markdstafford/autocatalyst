import { z } from 'zod';

import { frontedResourceSchema, nonModelPrincipalSchema, requireTenantMatchesOwner } from './domain-value-objects.js';

export const publicationSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  owner: nonModelPrincipalSchema,
  tenant: z.string().min(1),
  provider: z.string().min(1),
  url: z.string().url(),
  label: z.string().min(1),
  frontedResource: frontedResourceSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict().superRefine(requireTenantMatchesOwner);

export const createPublicationInputSchema = z.object({
  runId: z.string().min(1),
  owner: nonModelPrincipalSchema,
  tenant: z.string().min(1),
  provider: z.string().min(1),
  url: z.string().url(),
  label: z.string().min(1),
  frontedResource: frontedResourceSchema
}).strict().superRefine(requireTenantMatchesOwner);

export type Publication = z.infer<typeof publicationSchema>;
export type CreatePublicationInput = z.infer<typeof createPublicationInputSchema>;
