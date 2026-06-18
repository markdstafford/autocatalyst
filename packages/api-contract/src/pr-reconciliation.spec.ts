import { describe, expect, it } from 'vitest';

import {
  pullRequestReconciliationPath,
  pullRequestReconciliationResponseSchema,
  reconcilePullRequestsSuccessStatusCode,
  type ReconcilePullRequestsResponse
} from './pr-reconciliation.js';

describe('pull-request reconciliation contract', () => {
  it('defines the stable protected action path and success status', () => {
    expect(pullRequestReconciliationPath).toBe('/v1/pull-requests/reconcile');
    expect(reconcilePullRequestsSuccessStatusCode).toBe(200);
  });

  it('accepts the bounded reconciliation summary shape', () => {
    const parsed: ReconcilePullRequestsResponse = pullRequestReconciliationResponseSchema.parse({
      checked: 0,
      merged: 1,
      closed: 0,
      failed: 0,
      timedOut: false
    });

    expect(parsed).toEqual({ checked: 0, merged: 1, closed: 0, failed: 0, timedOut: false });
  });

  it('documents checked as open-only provider reads by keeping merged exclusive', () => {
    const parsed = pullRequestReconciliationResponseSchema.parse({
      checked: 0,
      merged: 1,
      closed: 1,
      failed: 1,
      timedOut: true
    });

    expect(parsed.checked).toBe(0);
    expect(parsed.merged).toBe(1);
    expect(parsed.closed).toBe(1);
    expect(parsed.failed).toBe(1);
  });

  it('rejects negative, fractional, missing, and unknown fields', () => {
    expect(() => pullRequestReconciliationResponseSchema.parse({ checked: -1, merged: 0, closed: 0, failed: 0, timedOut: false })).toThrow();
    expect(() => pullRequestReconciliationResponseSchema.parse({ checked: 0.5, merged: 0, closed: 0, failed: 0, timedOut: false })).toThrow();
    expect(() => pullRequestReconciliationResponseSchema.parse({ checked: 0, merged: 0, failed: 0, timedOut: false })).toThrow();
    expect(() => pullRequestReconciliationResponseSchema.parse({ checked: 0, merged: 0, closed: 0, failed: 0, timedOut: false, token: 'ghp_TEST_TOKEN_123' })).toThrow();
  });
});
