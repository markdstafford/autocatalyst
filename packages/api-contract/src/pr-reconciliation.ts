import { z } from 'zod';

export const pullRequestReconciliationPath = '/v1/pull-requests/reconcile' as const;
export const reconcilePullRequestsSuccessStatusCode = 200 as const;

/**
 * `checked` counts provider PR reads that complete and still report an open PR.
 * Merged, closed-without-merge, and failed outcomes are counted exclusively in
 * `merged`, `closed`, or `failed`, matching core detectPullRequestMerges semantics.
 */
export const pullRequestReconciliationResponseSchema = z.object({
  checked: z.number().int().nonnegative(),
  merged: z.number().int().nonnegative(),
  closed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  timedOut: z.boolean()
}).strict();

export type ReconcilePullRequestsResponse = z.infer<typeof pullRequestReconciliationResponseSchema>;
