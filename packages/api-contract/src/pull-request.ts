import { z } from 'zod';

import { runSchema } from './run.js';
import { nonModelPrincipalSchema, requireTenantMatchesOwner } from './domain-value-objects.js';

export const pullRequestStateSchema = z.enum(['open', 'merged', 'closed']);

export const pullRequestSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  owner: nonModelPrincipalSchema,
  tenant: z.string().min(1),
  provider: z.string().min(1),
  number: z.number().int().min(1),
  url: z.string().url(),
  state: pullRequestStateSchema,
  branch: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict().superRefine(requireTenantMatchesOwner);

export const createPullRequestInputSchema = z.object({
  runId: z.string().min(1),
  owner: nonModelPrincipalSchema,
  tenant: z.string().min(1),
  provider: z.string().min(1),
  number: z.number().int().min(1),
  url: z.string().url(),
  state: pullRequestStateSchema,
  branch: z.string().min(1)
}).strict().superRefine(requireTenantMatchesOwner);

export const runPullRequestPath = '/v1/runs/:id/pull-request' as const;
export const getRunPullRequestSuccessStatusCode = 200 as const;
export const runPullRequestResponseSchema = z.object({
  pullRequest: pullRequestSchema
}).strict();
export type RunPullRequestResponse = z.infer<typeof runPullRequestResponseSchema>;

export type PullRequestState = z.infer<typeof pullRequestStateSchema>;
export type PullRequest = z.infer<typeof pullRequestSchema>;
export type CreatePullRequestInput = z.infer<typeof createPullRequestInputSchema>;

export const runPullRequestRefreshPath = '/v1/runs/:id/pull-request/refresh' as const;
export const refreshRunPullRequestSuccessStatusCode = 200 as const;
export const runPullRequestRefreshRequestSchema = z.object({}).strict();
export const runPullRequestRefreshResponseSchema = z.object({
  pullRequest: pullRequestSchema,
  run: runSchema
}).strict();
export type RunPullRequestRefreshRequest = z.infer<typeof runPullRequestRefreshRequestSchema>;
export type RunPullRequestRefreshResponse = z.infer<typeof runPullRequestRefreshResponseSchema>;

export const pullRequestCheckFailureReasonSchema = z.enum([
  'credential_missing', 'authentication_failed', 'not_found', 'provider_unavailable'
]);
export type PullRequestCheckFailureReason = z.infer<typeof pullRequestCheckFailureReasonSchema>;
export const pullRequestCheckFailedErrorCode = 'pull_request_check_failed' as const;
export const pullRequestCheckFailedMessage = 'Could not check the pull request.' as const;
export const pullRequestCheckFailedResponseSchema = z.object({
  error: z.object({
    code: z.literal(pullRequestCheckFailedErrorCode),
    message: z.literal(pullRequestCheckFailedMessage),
    details: z.object({ reason: pullRequestCheckFailureReasonSchema }).strict()
  }).strict()
}).strict();
