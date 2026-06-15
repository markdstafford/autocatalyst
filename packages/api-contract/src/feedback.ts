import { z } from 'zod';

import { feedbackAnchorSchema, feedbackThreadSchema, nonModelPrincipalSchema, requireTenantMatchesOwner } from './domain-value-objects.js';

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

export const runFeedbackPath = '/v1/runs/:id/feedback' as const;
export const createRunFeedbackSuccessStatusCode = 201 as const;
export const listRunFeedbackSuccessStatusCode = 200 as const;

export const createRunFeedbackRequestSchema = z.object({
  target: z.literal('artifact'),
  title: z.string().min(1),
  body: z.string().min(1),
  anchor: feedbackAnchorSchema.optional()
}).strict();

export const runFeedbackListResponseSchema = z.object({
  feedback: z.array(feedbackSchema)
}).strict();

export const runFeedbackThreadPath = '/v1/runs/:id/feedback/:feedbackId/thread' as const;
export const appendRunFeedbackThreadSuccessStatusCode = 200 as const;

export const runFeedbackThreadParamsSchema = z.object({
  id: z.string().min(1),
  feedbackId: z.string().min(1)
}).strict();

export const appendRunFeedbackThreadRequestSchema = z.object({
  body: z.string().min(1)
}).strict();

export type FeedbackStatus = z.infer<typeof feedbackStatusSchema>;
export type FeedbackTarget = z.infer<typeof feedbackTargetSchema>;
export type Feedback = z.infer<typeof feedbackSchema>;
export type CreateFeedbackInput = z.infer<typeof createFeedbackInputSchema>;
export type CreateRunFeedbackRequest = z.infer<typeof createRunFeedbackRequestSchema>;
export type RunFeedbackListResponse = z.infer<typeof runFeedbackListResponseSchema>;
export type AppendRunFeedbackThreadRequest = z.infer<typeof appendRunFeedbackThreadRequestSchema>;
