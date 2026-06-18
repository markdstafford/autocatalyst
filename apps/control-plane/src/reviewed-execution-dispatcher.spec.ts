import { describe, expect, it, vi } from 'vitest';

import type { JsonValue } from '@autocatalyst/api-contract';
import type { ExecutionRunUnitOfWork, RunWorkInput, RunWorkResult } from '@autocatalyst/core';
import type { RunRoleWorkInput } from '@autocatalyst/core';
import { ClassifiedProviderFailureError } from '@autocatalyst/execution';

import { createReviewedExecutionDispatcher } from './reviewed-execution-dispatcher.js';

const runId = 'run_test_1';
const tenant = 'tenant_test_1';

function makeRunWorkInput(overrides: Partial<RunWorkInput> = {}): RunWorkInput {
  return {
    runId,
    run: {
      id: runId,
      topicId: 'topic_1',
      owner: { id: 'user_1', kind: 'human', tenantId: tenant },
      tenant,
      workKind: 'feature',
      currentStep: 'implementation.build',
      terminal: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    } as RunWorkInput['run'],
    tenant,
    ...overrides
  };
}

function makeRoleInput(
  role: 'implementer' | 'reviewer',
  round = 1,
  overrides: Partial<RunRoleWorkInput> = {}
): RunRoleWorkInput {
  return {
    ...makeRunWorkInput(),
    role,
    round,
    ...overrides
  };
}

function makeMockUnitOfWork(
  result: RunWorkResult = { directive: 'advance' },
  checkpointResult?: JsonValue
): ExecutionRunUnitOfWork {
  return {
    run: vi.fn().mockResolvedValue(result),
    runWithCheckpoint: vi.fn().mockResolvedValue({ workResult: result, checkpointResult })
  };
}

// ---------------------------------------------------------------------------
// 1. Implementer dispatch calls the underlying unit of work
// ---------------------------------------------------------------------------

describe('createReviewedExecutionDispatcher', () => {
  describe('implementer dispatch', () => {
    it('calls runWithCheckpoint on the underlying unit of work', async () => {
      const uow = makeMockUnitOfWork({ directive: 'advance' });
      const dispatcher = createReviewedExecutionDispatcher({ unitOfWork: uow });

      const input = makeRoleInput('implementer');
      const result = await dispatcher.runRole(input);

      expect(uow.runWithCheckpoint).toHaveBeenCalledOnce();
      expect(result.workResult).toEqual({ directive: 'advance' });
    });

    it('forwards advance work result', async () => {
      const uow = makeMockUnitOfWork({ directive: 'advance', result: { key: 'value' } });
      const dispatcher = createReviewedExecutionDispatcher({ unitOfWork: uow });

      const result = await dispatcher.runRole(makeRoleInput('implementer'));

      expect(result.workResult.directive).toBe('advance');
    });

    it('forwards fail work result', async () => {
      const uow = makeMockUnitOfWork({ directive: 'fail', reason: 'something went wrong' });
      const dispatcher = createReviewedExecutionDispatcher({ unitOfWork: uow });

      const result = await dispatcher.runRole(makeRoleInput('implementer'));

      expect(result.workResult.directive).toBe('fail');
    });

    it('includes sessionCheckpointResult when available', async () => {
      const checkpoint: JsonValue = { key: 'data' };
      const uow = makeMockUnitOfWork({ directive: 'advance' }, checkpoint);
      const dispatcher = createReviewedExecutionDispatcher({ unitOfWork: uow });

      const result = await dispatcher.runRole(makeRoleInput('implementer'));

      expect(result.sessionCheckpointResult).toEqual(checkpoint);
    });

    it('omits sessionCheckpointResult when not available', async () => {
      const uow = makeMockUnitOfWork({ directive: 'advance' });
      const dispatcher = createReviewedExecutionDispatcher({ unitOfWork: uow });

      const result = await dispatcher.runRole(makeRoleInput('implementer'));

      expect(result.sessionCheckpointResult).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Reviewer dispatch forces read_only regardless of input toolPolicyMode
  // ---------------------------------------------------------------------------

  describe('reviewer dispatch — tool policy enforcement', () => {
    it('forces read_only for reviewer regardless of toolPolicyMode omitted', async () => {
      const uow = makeMockUnitOfWork();
      const dispatcher = createReviewedExecutionDispatcher({ unitOfWork: uow });

      const input = makeRoleInput('reviewer'); // no toolPolicyMode
      await dispatcher.runRole(input);

      const callArg = (uow.runWithCheckpoint as ReturnType<typeof vi.fn>).mock.calls[0][0] as RunRoleWorkInput;
      expect(callArg.toolPolicyMode).toBe('read_only');
    });

    it('forces read_only for reviewer even when toolPolicyMode is write', async () => {
      const uow = makeMockUnitOfWork();
      const dispatcher = createReviewedExecutionDispatcher({ unitOfWork: uow });

      const input = makeRoleInput('reviewer', 1, { toolPolicyMode: 'write' });
      await dispatcher.runRole(input);

      const callArg = (uow.runWithCheckpoint as ReturnType<typeof vi.fn>).mock.calls[0][0] as RunRoleWorkInput;
      expect(callArg.toolPolicyMode).toBe('read_only');
    });

    it('keeps write mode for implementer when toolPolicyMode is unset', async () => {
      const uow = makeMockUnitOfWork();
      const dispatcher = createReviewedExecutionDispatcher({ unitOfWork: uow });

      const input = makeRoleInput('implementer'); // no toolPolicyMode
      await dispatcher.runRole(input);

      const callArg = (uow.runWithCheckpoint as ReturnType<typeof vi.fn>).mock.calls[0][0] as RunRoleWorkInput;
      expect(callArg.toolPolicyMode).toBe('write');
    });

    it('passes through explicit write for implementer', async () => {
      const uow = makeMockUnitOfWork();
      const dispatcher = createReviewedExecutionDispatcher({ unitOfWork: uow });

      const input = makeRoleInput('implementer', 1, { toolPolicyMode: 'write' });
      await dispatcher.runRole(input);

      const callArg = (uow.runWithCheckpoint as ReturnType<typeof vi.fn>).mock.calls[0][0] as RunRoleWorkInput;
      expect(callArg.toolPolicyMode).toBe('write');
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Session records correct role/round
  // ---------------------------------------------------------------------------

  describe('session role and round forwarding', () => {
    it('forwards role and round from input to the underlying call', async () => {
      const uow = makeMockUnitOfWork();
      const dispatcher = createReviewedExecutionDispatcher({ unitOfWork: uow });

      const input = makeRoleInput('reviewer', 2);
      await dispatcher.runRole(input);

      const callArg = (uow.runWithCheckpoint as ReturnType<typeof vi.fn>).mock.calls[0][0] as RunRoleWorkInput;
      expect(callArg.role).toBe('reviewer');
      expect(callArg.round).toBe(2);
    });

    it('forwards implementer role and round 1', async () => {
      const uow = makeMockUnitOfWork();
      const dispatcher = createReviewedExecutionDispatcher({ unitOfWork: uow });

      await dispatcher.runRole(makeRoleInput('implementer', 1));

      const callArg = (uow.runWithCheckpoint as ReturnType<typeof vi.fn>).mock.calls[0][0] as RunRoleWorkInput;
      expect(callArg.role).toBe('implementer');
      expect(callArg.round).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Reviewer result parsed from session checkpoint
  // ---------------------------------------------------------------------------

  describe('reviewer result parsing', () => {
    it('parses satisfied reviewer result from checkpoint', async () => {
      const checkpoint: JsonValue = { status: 'satisfied' };
      const uow = makeMockUnitOfWork({ directive: 'advance' }, checkpoint);
      const dispatcher = createReviewedExecutionDispatcher({ unitOfWork: uow });

      const result = await dispatcher.runRole(makeRoleInput('reviewer'));

      expect(result.reviewerResult).toEqual({ status: 'satisfied' });
    });

    it('parses findings reviewer result from checkpoint', async () => {
      const checkpoint: JsonValue = {
        status: 'findings',
        findings: [
          { title: 'Missing null check', body: 'The function does not check for null.', severity: 'blocker' }
        ]
      };
      const uow = makeMockUnitOfWork({ directive: 'advance' }, checkpoint);
      const dispatcher = createReviewedExecutionDispatcher({ unitOfWork: uow });

      const result = await dispatcher.runRole(makeRoleInput('reviewer'));

      expect(result.reviewerResult?.status).toBe('findings');
      expect(result.reviewerResult && 'findings' in result.reviewerResult
        ? result.reviewerResult.findings
        : []).toHaveLength(1);
    });

    it('returns undefined reviewerResult when checkpoint is not a valid reviewer result', async () => {
      const checkpoint: JsonValue = { unrelated: 'data' };
      const uow = makeMockUnitOfWork({ directive: 'advance' }, checkpoint);
      const dispatcher = createReviewedExecutionDispatcher({ unitOfWork: uow });

      const result = await dispatcher.runRole(makeRoleInput('reviewer'));

      expect(result.reviewerResult).toBeUndefined();
    });

    it('does not set reviewerResult for implementer sessions', async () => {
      const checkpoint: JsonValue = { status: 'satisfied' };
      const uow = makeMockUnitOfWork({ directive: 'advance' }, checkpoint);
      const dispatcher = createReviewedExecutionDispatcher({ unitOfWork: uow });

      const result = await dispatcher.runRole(makeRoleInput('implementer'));

      expect(result.reviewerResult).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Implementer dispositions parsed from checkpoint
  // ---------------------------------------------------------------------------

  describe('implementer dispositions parsing', () => {
    it('parses fixed disposition from checkpoint', async () => {
      const checkpoint: JsonValue = {
        dispositions: [
          { feedbackId: 'fb_1', disposition: 'fixed', summary: 'Added null check' }
        ]
      };
      const uow = makeMockUnitOfWork({ directive: 'advance' }, checkpoint);
      const dispatcher = createReviewedExecutionDispatcher({ unitOfWork: uow });

      const result = await dispatcher.runRole(makeRoleInput('implementer'));

      expect(result.dispositions).toHaveLength(1);
      expect(result.dispositions?.[0]).toMatchObject({ feedbackId: 'fb_1', disposition: 'fixed' });
    });

    it('parses declined disposition from checkpoint', async () => {
      const checkpoint: JsonValue = {
        dispositions: [
          { feedbackId: 'fb_2', disposition: 'declined', reason: 'Already handled by validation layer' }
        ]
      };
      const uow = makeMockUnitOfWork({ directive: 'advance' }, checkpoint);
      const dispatcher = createReviewedExecutionDispatcher({ unitOfWork: uow });

      const result = await dispatcher.runRole(makeRoleInput('implementer'));

      expect(result.dispositions?.[0]).toMatchObject({
        feedbackId: 'fb_2',
        disposition: 'declined',
        reason: 'Already handled by validation layer'
      });
    });

    it('returns undefined dispositions when checkpoint has no dispositions key', async () => {
      const checkpoint: JsonValue = { status: 'some_other_thing' };
      const uow = makeMockUnitOfWork({ directive: 'advance' }, checkpoint);
      const dispatcher = createReviewedExecutionDispatcher({ unitOfWork: uow });

      const result = await dispatcher.runRole(makeRoleInput('implementer'));

      expect(result.dispositions).toBeUndefined();
    });

    it('does not set dispositions for reviewer sessions', async () => {
      const checkpoint: JsonValue = {
        dispositions: [
          { feedbackId: 'fb_1', disposition: 'fixed', summary: 'Fixed' }
        ]
      };
      const uow = makeMockUnitOfWork({ directive: 'advance' }, checkpoint);
      const dispatcher = createReviewedExecutionDispatcher({ unitOfWork: uow });

      const result = await dispatcher.runRole(makeRoleInput('reviewer'));

      expect(result.dispositions).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Session metadata (sessionId, lastPosition, modelPrincipal)
  // ---------------------------------------------------------------------------

  describe('session metadata extraction', () => {
    it('extracts sessionId from checkpoint when present', async () => {
      const checkpoint: JsonValue = { sessionId: 'sess_abc123' };
      const uow = makeMockUnitOfWork({ directive: 'advance' }, checkpoint);
      const dispatcher = createReviewedExecutionDispatcher({ unitOfWork: uow });

      const result = await dispatcher.runRole(makeRoleInput('implementer'));

      expect(result.sessionId).toBe('sess_abc123');
    });

    it('extracts lastPosition from checkpoint when present', async () => {
      const checkpoint: JsonValue = { lastPosition: 'pos_xyz789' };
      const uow = makeMockUnitOfWork({ directive: 'advance' }, checkpoint);
      const dispatcher = createReviewedExecutionDispatcher({ unitOfWork: uow });

      const result = await dispatcher.runRole(makeRoleInput('implementer'));

      expect(result.lastPosition).toBe('pos_xyz789');
    });

    it('extracts modelPrincipal from checkpoint when present', async () => {
      const checkpoint: JsonValue = {
        modelPrincipal: {
          id: 'claude-sonnet-4',
          kind: 'model',
          tenantId: tenant
        }
      };
      const uow = makeMockUnitOfWork({ directive: 'advance' }, checkpoint);
      const dispatcher = createReviewedExecutionDispatcher({ unitOfWork: uow });

      const result = await dispatcher.runRole(makeRoleInput('implementer'));

      expect(result.modelPrincipal).toEqual({
        id: 'claude-sonnet-4',
        kind: 'model',
        tenantId: tenant
      });
    });

    it('returns no session metadata when checkpoint is absent', async () => {
      const uow = makeMockUnitOfWork({ directive: 'advance' });
      const dispatcher = createReviewedExecutionDispatcher({ unitOfWork: uow });

      const result = await dispatcher.runRole(makeRoleInput('implementer'));

      expect(result.sessionId).toBeUndefined();
      expect(result.lastPosition).toBeUndefined();
      expect(result.modelPrincipal).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // 7. Context injection — reviewContext and reviewer policy forwarding
  // ---------------------------------------------------------------------------

  describe('context injection', () => {
    it('passes role, round, and previousFindings to implementer in review context', async () => {
      const uow = makeMockUnitOfWork();
      const dispatcher = createReviewedExecutionDispatcher({ unitOfWork: uow });

      const reviewContext = {
        previousFindings: [
          {
            feedbackId: 'fb_1',
            title: 'Missing null check',
            body: 'The function does not check for null.',
            severity: 'blocker' as const
          }
        ]
      };
      const input = makeRoleInput('implementer', 2, { reviewContext });
      await dispatcher.runRole(input);

      const callArg = (uow.runWithCheckpoint as ReturnType<typeof vi.fn>).mock.calls[0][0] as RunRoleWorkInput;
      expect(callArg.role).toBe('implementer');
      expect(callArg.round).toBe(2);
      expect(callArg.reviewContext).toEqual(reviewContext);
      expect(callArg.reviewContext?.previousFindings).toHaveLength(1);
      expect(callArg.reviewContext?.previousFindings?.[0]).toMatchObject({
        feedbackId: 'fb_1',
        severity: 'blocker'
      });
    });

    it('passes read-only reviewer policy signal to reviewer dispatch', async () => {
      const uow = makeMockUnitOfWork();
      const dispatcher = createReviewedExecutionDispatcher({ unitOfWork: uow });

      const input = makeRoleInput('reviewer', 1);
      await dispatcher.runRole(input);

      const callArg = (uow.runWithCheckpoint as ReturnType<typeof vi.fn>).mock.calls[0][0] as RunRoleWorkInput & {
        reviewerPolicy?: { fileAccess: string; gitAccess: string };
      };
      expect(callArg.reviewerPolicy).toEqual({ fileAccess: 'read_only', gitAccess: 'read_only' });
    });

    it('does not set reviewerPolicy for implementer dispatch', async () => {
      const uow = makeMockUnitOfWork();
      const dispatcher = createReviewedExecutionDispatcher({ unitOfWork: uow });

      const input = makeRoleInput('implementer', 1);
      await dispatcher.runRole(input);

      const callArg = (uow.runWithCheckpoint as ReturnType<typeof vi.fn>).mock.calls[0][0] as RunRoleWorkInput & {
        reviewerPolicy?: unknown;
      };
      expect(callArg.reviewerPolicy).toBeUndefined();
    });

    it('lastPosition in result does not include raw secrets or credentials', async () => {
      // The lastPosition is sourced from checkpoint data parsed through safeSessionMetadataSchema.
      // The schema only allows a plain string — it cannot contain structured credential fields.
      // Verify the string value is passed through as-is (no expansion of secrets).
      const checkpoint = {
        lastPosition: 'cursor_abc123'
      };
      const uow = makeMockUnitOfWork({ directive: 'advance' }, checkpoint);
      const dispatcher = createReviewedExecutionDispatcher({ unitOfWork: uow });

      const result = await dispatcher.runRole(makeRoleInput('implementer'));

      expect(result.lastPosition).toBe('cursor_abc123');
      // A raw secret value should never appear in the lastPosition.
      expect(result.lastPosition).not.toMatch(/sk-[a-zA-Z0-9]/u);
      expect(result.lastPosition).not.toMatch(/bearer /iu);
    });

    it('modelPrincipal in result contains only safe identity fields, not credential data', async () => {
      const checkpoint = {
        modelPrincipal: {
          id: 'claude-sonnet-4',
          kind: 'model',
          tenantId: tenant,
          displayName: 'Claude Sonnet 4'
        }
      };
      const uow = makeMockUnitOfWork({ directive: 'advance' }, checkpoint);
      const dispatcher = createReviewedExecutionDispatcher({ unitOfWork: uow });

      const result = await dispatcher.runRole(makeRoleInput('reviewer'));

      // Safe identity fields are present
      expect(result.modelPrincipal?.id).toBe('claude-sonnet-4');
      expect(result.modelPrincipal?.kind).toBe('model');
      expect(result.modelPrincipal?.tenantId).toBe(tenant);
      // No additional credential-like fields leak through (strict schema)
      expect(Object.keys(result.modelPrincipal ?? {})).not.toContain('apiKey');
      expect(Object.keys(result.modelPrincipal ?? {})).not.toContain('secret');
      expect(Object.keys(result.modelPrincipal ?? {})).not.toContain('token');
    });

    it('forwards reviewContext with previousRounds to the underlying unit of work', async () => {
      const uow = makeMockUnitOfWork();
      const dispatcher = createReviewedExecutionDispatcher({ unitOfWork: uow });

      const reviewContext = {
        previousRounds: [
          {
            round: 1,
            implementerSessionId: 'sess_impl_1',
            reviewerSessionId: 'sess_rev_1',
            changedFileCount: 3,
            findings: [
              {
                feedbackId: 'fb_1',
                title: 'Bug',
                severity: 'blocker' as const,
                body: 'Fix this',
                blocking: true,
                signature: 'sig_abc'
              }
            ],
            dispositions: [],
            outcome: 'continue' as const
          }
        ]
      };
      const input = makeRoleInput('implementer', 2, { reviewContext });
      await dispatcher.runRole(input);

      const callArg = (uow.runWithCheckpoint as ReturnType<typeof vi.fn>).mock.calls[0][0] as RunRoleWorkInput;
      expect(callArg.reviewContext?.previousRounds).toHaveLength(1);
      expect(callArg.reviewContext?.previousRounds?.[0]).toMatchObject({
        round: 1,
        outcome: 'continue'
      });
    });
  });

  // ---------------------------------------------------------------------------
  // 8. Reviewer read-only enforcement — explicit violation and policy error
  // ---------------------------------------------------------------------------

  describe('reviewer read-only enforcement', () => {
    it('dispatcher overrides toolPolicyMode to read_only when reviewer passes write explicitly', async () => {
      const uow = makeMockUnitOfWork();
      const dispatcher = createReviewedExecutionDispatcher({ unitOfWork: uow });

      // Attempt to dispatch reviewer with write — should be silently overridden.
      const input = makeRoleInput('reviewer', 1, { toolPolicyMode: 'write' });
      await dispatcher.runRole(input);

      const callArg = (uow.runWithCheckpoint as ReturnType<typeof vi.fn>).mock.calls[0][0] as RunRoleWorkInput;
      // The dispatcher must override the caller-supplied 'write' with 'read_only'.
      expect(callArg.toolPolicyMode).toBe('read_only');
    });

    it('returns sanitized fail directive when unit of work throws a policy-rejection error for reviewer read-only', async () => {
      // Simulate a provider that rejects a read-only policy constraint (e.g. an
      // adapter that does not support the read_only toolPolicyMode). The raw error
      // message must NOT appear in the fail reason — only a safe code is allowed.
      const policyError = new Error('read_only policy not supported by this provider: secret-provider-key=xyz');
      const uow: ExecutionRunUnitOfWork = {
        run: vi.fn(),
        runWithCheckpoint: vi.fn().mockRejectedValue(policyError)
      };
      const dispatcher = createReviewedExecutionDispatcher({ unitOfWork: uow });

      const result = await dispatcher.runRole(makeRoleInput('reviewer', 1));

      expect(result.workResult.directive).toBe('fail');
      if (result.workResult.directive === 'fail') {
        // No raw error message, no credential-like strings in the reason.
        expect(result.workResult.reason).not.toContain('secret-provider-key=xyz');
        expect(result.workResult.reason).not.toContain('not supported by this provider');
        // The reason must be a non-empty string (a safe code or safe phrase).
        expect(typeof result.workResult.reason).toBe('string');
        expect(result.workResult.reason.length).toBeGreaterThan(0);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 9. Sanitized failures — no secrets in error data
  // ---------------------------------------------------------------------------

  describe('sanitized failure handling', () => {
    it('returns fail directive when underlying unit of work throws an unexpected error', async () => {
      const uow: ExecutionRunUnitOfWork = {
        run: vi.fn(),
        runWithCheckpoint: vi.fn().mockRejectedValue(new Error('Something exploded'))
      };
      const dispatcher = createReviewedExecutionDispatcher({ unitOfWork: uow });

      const result = await dispatcher.runRole(makeRoleInput('implementer'));

      expect(result.workResult.directive).toBe('fail');
      // Ensure no raw error messages containing mock secrets pass through.
      if ('reason' in result.workResult) {
        expect(result.workResult.reason).not.toContain('sk-test-secret');
      }
    });

    it('does not leak secret values through failure reason', async () => {
      const uow: ExecutionRunUnitOfWork = {
        run: vi.fn(),
        runWithCheckpoint: vi.fn().mockRejectedValue(
          new Error('Connection failed with key sk-test-secret and token bearer xyz')
        )
      };
      const dispatcher = createReviewedExecutionDispatcher({ unitOfWork: uow });

      const result = await dispatcher.runRole(makeRoleInput('reviewer'));

      expect(result.workResult.directive).toBe('fail');
      // The dispatcher sanitizes through safeFailureReasonFromError, so the raw
      // error message should not appear in the directive reason.
      if (result.workResult.directive === 'fail') {
        expect(result.workResult.reason).not.toContain('sk-test-secret');
        expect(result.workResult.reason).not.toContain('bearer xyz');
      }
    });

    it('maps thrown provider-shaped transient errors to transient_provider_failure without raw details', async () => {
      const rawError = Object.assign(new Error('API Error: Overloaded sk-test-secret /Users/mark/private'), {
        status: 429,
        name: 'ProviderApiError',
        code: 'sk-test-secret'
      });
      const dispatcher = createReviewedExecutionDispatcher({
        unitOfWork: {
          run: vi.fn(),
          async runWithCheckpoint() {
            throw rawError;
          }
        }
      });

      const result = await dispatcher.runRole(makeRoleInput('reviewer'));

      expect(result.workResult).toEqual({ directive: 'fail', reason: 'transient_provider_failure' });
      expect(JSON.stringify(result)).not.toContain('sk-test-secret');
      expect(JSON.stringify(result)).not.toContain('/Users/mark/private');
      expect(JSON.stringify(result)).not.toContain('API Error: Overloaded');
    });

    it('returns the sanitized reason string for classified provider failures', async () => {
      // provider_auth_failed is a known KnownFailureReasonCode accepted by ClassifiedProviderFailureError.
      const err = new ClassifiedProviderFailureError('provider_auth_failed');
      const uow: ExecutionRunUnitOfWork = {
        run: vi.fn(),
        runWithCheckpoint: vi.fn().mockRejectedValue(err)
      };
      const dispatcher = createReviewedExecutionDispatcher({ unitOfWork: uow });

      const result = await dispatcher.runRole(makeRoleInput('implementer'));

      expect(result.workResult.directive).toBe('fail');
      if (result.workResult.directive === 'fail') {
        expect(result.workResult.reason).toContain('provider_auth_failed');
      }
    });
  });
});
