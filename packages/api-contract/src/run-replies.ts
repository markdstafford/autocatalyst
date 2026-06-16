import { z } from 'zod';

import { feedbackAnchorSchema } from './domain-value-objects.js';
import { feedbackTargetSchema } from './feedback.js';
import { runSchema } from './run.js';

export const runRepliesPath = '/v1/runs/:id/replies' as const;
export const createRunReplySuccessStatusCode = 200 as const;

export const runReplyRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('approve'),
    body: z.string().min(1).optional()
  }).strict(),
  z.object({
    kind: z.literal('feedback'),
    title: z.string().min(1),
    body: z.string().min(1),
    anchor: feedbackAnchorSchema.optional()
  }).strict(),
  z.object({
    kind: z.literal('guidance'),
    body: z.string().min(1)
  }).strict()
]);

export const runReplyClassificationSchema = z.object({
  directive: z.enum(['advance', 'revise']),
  target: feedbackTargetSchema.optional(),
  createdFeedbackId: z.string().min(1).optional(),
  pauseKind: z.literal('convergence_escalation').optional()
}).strict();

export const runReplyResponseSchema = z.object({
  run: runSchema,
  classification: runReplyClassificationSchema
}).strict();

export type RunReplyRequest = z.infer<typeof runReplyRequestSchema>;
export type RunReplyClassification = z.infer<typeof runReplyClassificationSchema>;
export type RunReplyResponse = z.infer<typeof runReplyResponseSchema>;
