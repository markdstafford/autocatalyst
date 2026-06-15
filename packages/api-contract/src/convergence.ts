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

export const convergenceRoundOutcomeSchema = z.enum(['continue', 'converged', 'max_rounds', 'oscillation']);
export const convergenceOutcomeSchema = z.enum(['converged', 'max_rounds', 'oscillation', 'needs_input']);
export const convergenceRoutingWarningCodeSchema = z.enum(['role_distinct_unsatisfied']);

export const convergenceRoundFindingSchema = reviewerFindingContextSchema.extend({
  blocking: z.boolean(),
  signature: z.string().min(1)
}).strict();

export const convergenceRoundRecordSchema = z.object({
  round: z.number().int().min(1),
  implementerSessionId: z.string().min(1).optional(),
  reviewerSessionId: z.string().min(1).optional(),
  implementerCommitSha: z.string().min(1).nullable().optional(),
  changedFileCount: z.number().int().min(0),
  findings: z.array(convergenceRoundFindingSchema),
  dispositions: z.array(findingDispositionSchema),
  outcome: convergenceRoundOutcomeSchema
}).strict();

export const convergenceCheckpointSchema = z.object({
  kind: z.literal('convergence_review'),
  step: z.string().min(1),
  maxRounds: z.number().int().min(1),
  routing: z.object({
    distinct: z.boolean(),
    distinctBy: z.enum(['model', 'profile']).optional(),
    warningCode: convergenceRoutingWarningCodeSchema.optional()
  }).strict(),
  rounds: z.array(convergenceRoundRecordSchema),
  outcome: convergenceOutcomeSchema,
  openFeedbackIds: z.array(z.string().min(1)),
  lastPositions: z.object({
    implementer: z.string().min(1).optional(),
    reviewer: z.string().min(1).optional()
  }).strict()
}).strict();

export type ConvergenceRoundOutcome = z.infer<typeof convergenceRoundOutcomeSchema>;
export type ConvergenceOutcome = z.infer<typeof convergenceOutcomeSchema>;
export type ConvergenceRoutingWarningCode = z.infer<typeof convergenceRoutingWarningCodeSchema>;
export type ConvergenceRoundFinding = z.infer<typeof convergenceRoundFindingSchema>;
export type ConvergenceRoundRecord = z.infer<typeof convergenceRoundRecordSchema>;
export type ConvergenceCheckpoint = z.infer<typeof convergenceCheckpointSchema>;
