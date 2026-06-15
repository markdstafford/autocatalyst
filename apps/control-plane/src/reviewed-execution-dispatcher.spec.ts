import { describe, expect, it, vi } from 'vitest';

import type { JsonValue } from '@autocatalyst/api-contract';
import type { ExecutionRunUnitOfWork, RunWorkInput, RunWorkResult } from '@autocatalyst/core';
import type { RunRoleWorkInput } from '@autocatalyst/core';

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
  // 7. Sanitized failures — no secrets in error data
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

    it('returns the sanitized reason string for classified provider failures', async () => {
      const { ClassifiedProviderFailureError } = await import('@autocatalyst/execution');
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
