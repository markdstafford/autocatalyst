import { z } from 'zod';

import { channelReferenceSchema, nonModelPrincipalSchema } from './domain-value-objects.js';

function requireTenantMatchesOwner<T extends { owner: { tenantId: string }; tenant: string }>(value: T, context: z.RefinementCtx): void {
  if (value.tenant !== value.owner.tenantId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['tenant'], message: 'Tenant must match owner.tenantId.' });
  }
}

export const conversationSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  owner: nonModelPrincipalSchema,
  tenant: z.string().min(1),
  title: z.string().min(1),
  channel: channelReferenceSchema.optional(),
  activeTopicId: z.string().min(1).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict().superRefine(requireTenantMatchesOwner);

export const createConversationInputSchema = z.object({
  projectId: z.string().min(1),
  owner: nonModelPrincipalSchema,
  tenant: z.string().min(1),
  title: z.string().min(1),
  channel: channelReferenceSchema.optional(),
  activeTopicId: z.string().min(1).nullable()
}).strict().superRefine(requireTenantMatchesOwner);

export type Conversation = z.infer<typeof conversationSchema>;
export type CreateConversationInput = z.infer<typeof createConversationInputSchema>;
