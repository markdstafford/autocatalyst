import { z } from 'zod';

import { nonModelPrincipalSchema } from './domain-value-objects.js';
import { principalSchema } from './principal.js';

function requireTenantMatchesOwner<T extends { owner: { tenantId: string }; tenant: string }>(value: T, context: z.RefinementCtx): void {
  if (value.tenant !== value.owner.tenantId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['tenant'], message: 'Tenant must match owner.tenantId.' });
  }
}

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
