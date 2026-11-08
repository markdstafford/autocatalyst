import { z } from 'zod';

import { feedbackAnchorSchema, feedbackThreadSchema, nonModelPrincipalSchema, requireTenantMatchesOwner, responseFeedbackAnchorSchema } from './domain-value-objects.js';

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

// Read-response feedback item. Identical to the stored {@link feedbackSchema} except the anchor may
// carry the response-only `stale` flag after reconciliation. Never used for writes or persistence.
export const feedbackResponseSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  owner: nonModelPrincipalSchema,
  tenant: z.string().min(1),
  target: feedbackTargetSchema,
  status: feedbackStatusSchema,
  title: z.string().min(1),
  body: z.string().min(1),
  anchor: responseFeedbackAnchorSchema.optional(),
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
  feedback: z.array(feedbackResponseSchema)
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

// Feedback lifecycle update: resolve an addressed item or reopen a wont_fix item. The schema is
// strict and permits an optional body; service-level validation additionally requires a body for
// the `open` (reopen) transition because reopen appends a thread entry explaining the rejection.
export const updateRunFeedbackPath = '/v1/runs/:id/feedback/:feedbackId' as const;
export const updateRunFeedbackSuccessStatusCode = 200 as const;

export const updateRunFeedbackParamsSchema = z.object({
  id: z.string().min(1),
  feedbackId: z.string().min(1)
}).strict();

export const updateRunFeedbackRequestSchema = z.object({
  status: z.enum(['resolved', 'open']),
  body: z.string().min(1).optional()
}).strict();

export type FeedbackStatus = z.infer<typeof feedbackStatusSchema>;
export type FeedbackTarget = z.infer<typeof feedbackTargetSchema>;
export type Feedback = z.infer<typeof feedbackSchema>;
export type FeedbackResponse = z.infer<typeof feedbackResponseSchema>;
export type CreateFeedbackInput = z.infer<typeof createFeedbackInputSchema>;
export type CreateRunFeedbackRequest = z.infer<typeof createRunFeedbackRequestSchema>;
export type RunFeedbackListResponse = z.infer<typeof runFeedbackListResponseSchema>;
export type AppendRunFeedbackThreadRequest = z.infer<typeof appendRunFeedbackThreadRequestSchema>;
export type UpdateRunFeedbackRequest = z.infer<typeof updateRunFeedbackRequestSchema>;
