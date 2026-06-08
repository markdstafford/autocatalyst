import { z } from 'zod';

import { nonModelPrincipalSchema, requireTenantMatchesOwner } from './domain-value-objects.js';
import { principalSchema } from './principal.js';

export const messageDirectionSchema = z.enum(['inbound', 'outbound']);

export const messageSchema = z.object({
  id: z.string().min(1),
  topicId: z.string().min(1),
  owner: nonModelPrincipalSchema,
  tenant: z.string().min(1),
  author: principalSchema,
  direction: messageDirectionSchema,
  body: z.string().min(1),
  intent: z.string().min(1).optional(),
  createdAt: z.string().datetime()
}).strict().superRefine(requireTenantMatchesOwner);

export const createMessageInputSchema = z.object({
  topicId: z.string().min(1),
  owner: nonModelPrincipalSchema,
  tenant: z.string().min(1),
  author: principalSchema,
  direction: messageDirectionSchema,
  body: z.string().min(1),
  intent: z.string().min(1).optional()
}).strict().superRefine(requireTenantMatchesOwner);

export type MessageDirection = z.infer<typeof messageDirectionSchema>;
export type Message = z.infer<typeof messageSchema>;
export type CreateMessageInput = z.infer<typeof createMessageInputSchema>;
