import { z } from 'zod';

import { intakeRoutingErrorCode, validationErrorCode } from './errors.js';

export const issueTrackerErrorCodeSchema = z.enum([
  'tracker_not_configured',
  'unsupported_tracker_provider',
  'tracker_target_invalid',
  'tracker_credential_missing',
  'tracker_auth_failed',
  'issue_not_found',
  'tracker_provider_unavailable',
  'tracker_response_invalid'
]);
export type IssueTrackerErrorCode = z.infer<typeof issueTrackerErrorCodeSchema>;

const issueReferenceIntakeErrorCodeSchema = z.enum([
  'tracker_not_configured',
  'unsupported_tracker_provider',
  'tracker_target_invalid',
  'tracker_credential_missing',
  'tracker_read_failed',
  'issue_reference_ambiguous',
  'work_kind_unresolved'
]);
export type IssueReferenceIntakeErrorCode = z.infer<typeof issueReferenceIntakeErrorCodeSchema>;

export const intakeRoutingErrorDetailsSchema = z.union([
  z.object({
    code: z.enum([
      ...issueReferenceIntakeErrorCodeSchema.options,
      'project_not_accessible',
      'unknown_work_kind',
      'invalid_transition'
    ])
  }).strict(),
  z.object({
    code: issueTrackerErrorCodeSchema,
    trackerCode: issueTrackerErrorCodeSchema.describe('The typed adapter error code, equal to details.code.'),
    provider: z.string().min(1).optional(),
    repository: z.string().min(1).optional(),
    issueNumber: z.number().int().nonnegative().optional()
  }).strict().refine(details => details.code === details.trackerCode, {
    message: 'trackerCode must equal code.'
  })
]);
export type IntakeRoutingErrorDetails = z.infer<typeof intakeRoutingErrorDetailsSchema>;

export const intakeRoutingErrorResponseSchema = z.object({
  error: z.object({
    code: z.literal(intakeRoutingErrorCode),
    message: z.string().min(1),
    details: intakeRoutingErrorDetailsSchema
  }).strict()
}).strict();

export const intakeBadRequestResponseSchema = z.union([
  intakeRoutingErrorResponseSchema,
  z.object({
    error: z.object({
      code: z.literal(validationErrorCode),
      message: z.string().min(1),
      details: z.unknown().optional()
    }).strict()
  }).strict()
]);

