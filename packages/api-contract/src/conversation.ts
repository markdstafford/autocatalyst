import { z } from 'zod';

import { channelReferenceSchema, nonModelPrincipalSchema, requireTenantMatchesOwner } from './domain-value-objects.js';

export const conversationSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  owner: nonModelPrincipalSchema,
  tenant: z.string().min(1),
  identity: z.string().min(1),
  channel: channelReferenceSchema.optional(),
  activeTopicId: z.string().min(1).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict().superRefine(requireTenantMatchesOwner);

export const createConversationInputSchema = z.object({
  projectId: z.string().min(1),
  owner: nonModelPrincipalSchema,
  tenant: z.string().min(1),
  identity: z.string().min(1),
  channel: channelReferenceSchema.optional(),
  activeTopicId: z.string().min(1).nullable()
}).strict().superRefine(requireTenantMatchesOwner);

export type Conversation = z.infer<typeof conversationSchema>;
export type CreateConversationInput = z.infer<typeof createConversationInputSchema>;
