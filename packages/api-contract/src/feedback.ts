import { z } from 'zod';

import { feedbackAnchorSchema, feedbackThreadSchema, nonModelPrincipalSchema } from './domain-value-objects.js';

function requireTenantMatchesOwner<T extends { owner: { tenantId: string }; tenant: string }>(value: T, context: z.RefinementCtx): void {
  if (value.tenant !== value.owner.tenantId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['tenant'], message: 'Tenant must match owner.tenantId.' });
  }
}

export const feedbackStatusSchema = z.enum(['open', 'addressed', 'resolved', 'wont_fix']);
export const feedbackTargetSchema = z.enum(['artifact', 'implementation', 'docs', 'pr']);

export const feedbackSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  owner: nonModelPrincipalSchema,
  tenant: z.string().min(1),
  target: feedbackTargetSchema,
  status: feedbackStatusSchema,
  title: z.string().min(1),
  body: z.string().min(1),
  anchor: feedbackAnchorSchema.optional(),
  thread: feedbackThreadSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict().superRefine(requireTenantMatchesOwner);

export const createFeedbackInputSchema = z.object({
  runId: z.string().min(1),
  owner: nonModelPrincipalSchema,
  tenant: z.string().min(1),
  target: feedbackTargetSchema,
  status: feedbackStatusSchema,
  title: z.string().min(1),
  body: z.string().min(1),
  anchor: feedbackAnchorSchema.optional(),
  thread: feedbackThreadSchema
}).strict().superRefine(requireTenantMatchesOwner);

export type FeedbackStatus = z.infer<typeof feedbackStatusSchema>;
export type FeedbackTarget = z.infer<typeof feedbackTargetSchema>;
export type Feedback = z.infer<typeof feedbackSchema>;
export type CreateFeedbackInput = z.infer<typeof createFeedbackInputSchema>;
