import { z } from 'zod';

import { feedbackAnchorSchema } from './domain-value-objects.js';

export const reviewerFindingSeveritySchema = z.enum(['blocker', 'warning', 'info']);

export const reviewerFindingSchema = z.object({
  externalId: z.string().min(1).optional(),
  title: z.string().min(1),
  body: z.string().min(1),
  severity: reviewerFindingSeveritySchema,
  anchor: feedbackAnchorSchema.optional()
}).strict();

export const reviewerFindingContextSchema = reviewerFindingSchema.extend({
  feedbackId: z.string().min(1)
}).strict();

const satisfiedReviewerResultSchema = z.object({
  status: z.literal('satisfied'),
  findings: z.array(reviewerFindingSchema).length(0).optional()
}).strict();

const findingsReviewerResultSchema = z.object({
  status: z.literal('findings'),
  findings: z.array(reviewerFindingSchema).min(1)
}).strict();

export const reviewerResultSchema = z.discriminatedUnion('status', [
  satisfiedReviewerResultSchema,
  findingsReviewerResultSchema
]);

const fixedFindingDispositionSchema = z.object({
  feedbackId: z.string().min(1),
  disposition: z.literal('fixed'),
  summary: z.string().min(1)
}).strict();

const declinedFindingDispositionSchema = z.object({
  feedbackId: z.string().min(1),
  disposition: z.literal('declined'),
  reason: z.string().min(1)
}).strict();

export const findingDispositionSchema = z.discriminatedUnion('disposition', [
  fixedFindingDispositionSchema,
  declinedFindingDispositionSchema
]);

export type ReviewerFindingSeverity = z.infer<typeof reviewerFindingSeveritySchema>;
export type ReviewerFinding = z.infer<typeof reviewerFindingSchema>;
export type ReviewerFindingContext = z.infer<typeof reviewerFindingContextSchema>;
export type ReviewerResult = z.infer<typeof reviewerResultSchema>;
export type FindingDisposition = z.infer<typeof findingDispositionSchema>;
