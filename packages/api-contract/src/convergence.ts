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

export const implementationAltitudeSchema = z.enum(['layout', 'public_api', 'private_api', 'build']);
export const implementationConvergenceDepthSchema = z.enum(['build_only', 'layout', 'public_api', 'full']);
export const convergenceFindingSourceSchema = z.enum(['reviewer', 'altitude_contract', 'build_drift']);
export const convergenceFindingCategorySchema = z.enum([
  'layout',
  'public_api',
  'private_api',
  'build',
  'contract_violation',
  'build_drift'
]);

const nonBuildAltitudeSchema = z.enum(['layout', 'public_api', 'private_api']);

export const altitudeCheckpointRefSchema = z.object({
  altitude: nonBuildAltitudeSchema,
  ref: z.string().min(1),
  commitSha: z.string().min(1),
  acceptedAt: z.string().datetime()
}).strict();

export const convergenceRoundFindingSchema = reviewerFindingContextSchema.extend({
  blocking: z.boolean(),
  signature: z.string().min(1),
  source: convergenceFindingSourceSchema.optional(),
  altitude: implementationAltitudeSchema.optional(),
  category: convergenceFindingCategorySchema.optional(),
  blockingReason: z.string().min(1).optional(),
  deterministicKey: z.string().min(1).optional(),
  sourcePath: z.string().min(1).optional(),
  symbolName: z.string().min(1).optional(),
  acceptedCheckpoint: z.object({
    altitude: implementationAltitudeSchema,
    ref: z.string().min(1),
    commitSha: z.string().min(1)
  }).strict().optional()
}).strict();

const convergenceRoundRecordBaseSchema = z.object({
  round: z.number().int().min(1),
  implementerSessionId: z.string().min(1).optional(),
  reviewerSessionId: z.string().min(1).optional(),
  implementerCommitSha: z.string().min(1).nullable().optional(),
  changedFileCount: z.number().int().min(0),
  findings: z.array(convergenceRoundFindingSchema),
  dispositions: z.array(findingDispositionSchema),
  outcome: convergenceRoundOutcomeSchema,
  altitude: implementationAltitudeSchema
}).strict();

// Migration tolerance: existing round records lack `altitude` — default it to 'build'.
export const convergenceRoundRecordSchema = z.preprocess(
  (value) => {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      if (obj['altitude'] === undefined) {
        return { ...obj, altitude: 'build' };
      }
    }
    return value;
  },
  convergenceRoundRecordBaseSchema
);

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
  }).strict(),
  depth: implementationConvergenceDepthSchema.optional(),
  currentAltitude: implementationAltitudeSchema.optional(),
  acceptedCheckpoints: z.array(altitudeCheckpointRefSchema).optional(),
  cumulativeSummary: z.unknown().optional()
}).strict();

export type ConvergenceRoundOutcome = z.infer<typeof convergenceRoundOutcomeSchema>;
export type ConvergenceOutcome = z.infer<typeof convergenceOutcomeSchema>;
export type ConvergenceRoutingWarningCode = z.infer<typeof convergenceRoutingWarningCodeSchema>;
export type ConvergenceRoundFinding = z.infer<typeof convergenceRoundFindingSchema>;
export type ConvergenceRoundRecord = z.infer<typeof convergenceRoundRecordSchema>;
export type ConvergenceCheckpoint = z.infer<typeof convergenceCheckpointSchema>;
export type ImplementationAltitude = z.infer<typeof implementationAltitudeSchema>;
export type ImplementationConvergenceDepth = z.infer<typeof implementationConvergenceDepthSchema>;
export type ConvergenceFindingSource = z.infer<typeof convergenceFindingSourceSchema>;
export type ConvergenceFindingCategory = z.infer<typeof convergenceFindingCategorySchema>;
export type AltitudeCheckpointRef = z.infer<typeof altitudeCheckpointRefSchema>;
