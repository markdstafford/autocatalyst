import { z } from 'zod';

import { nonModelPrincipalSchema } from './domain-value-objects.js';

function requireTenantMatchesOwner<T extends { owner: { tenantId: string }; tenant: string }>(value: T, context: z.RefinementCtx): void {
  if (value.tenant !== value.owner.tenantId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['tenant'], message: 'Tenant must match owner.tenantId.' });
  }
}

export const topicKindSchema = z.enum(['main', 'side']);

export const topicSchema = z.object({
  id: z.string().min(1),
  conversationId: z.string().min(1),
  owner: nonModelPrincipalSchema,
  tenant: z.string().min(1),
  title: z.string().min(1),
  kind: topicKindSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict().superRefine(requireTenantMatchesOwner);

export const createTopicInputSchema = z.object({
  conversationId: z.string().min(1),
  owner: nonModelPrincipalSchema,
  tenant: z.string().min(1),
  title: z.string().min(1),
  kind: topicKindSchema
}).strict().superRefine(requireTenantMatchesOwner);

export type TopicKind = z.infer<typeof topicKindSchema>;
export type Topic = z.infer<typeof topicSchema>;
export type CreateTopicInput = z.infer<typeof createTopicInputSchema>;
