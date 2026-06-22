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

describe('createReviewedExecutionDispatcher session persistence wiring', () => {
  // ---------------------------------------------------------------------------
  // Verify that role, round, and step are forwarded through to the unit of work
  // so that session recording captures the correct context.
  // ---------------------------------------------------------------------------

  it('forwards role, round, and step for implementer dispatch', async () => {
    const uow = makeMockUnitOfWork({ directive: 'advance' });
    const dispatcher = createReviewedExecutionDispatcher({ unitOfWork: uow });

    await dispatcher.runRole(makeRoleInput('implementer', 1));

    expect(uow.runWithCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'implementer',
        round: 1,
        run: expect.objectContaining({ currentStep: 'implementation.build' })
      })
    );
  });

  it('forwards role, round, and step for reviewer dispatch', async () => {
    const uow = makeMockUnitOfWork({ directive: 'advance' });
    const dispatcher = createReviewedExecutionDispatcher({ unitOfWork: uow });

    await dispatcher.runRole(makeRoleInput('reviewer', 1));

    expect(uow.runWithCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'reviewer',
        round: 1,
        run: expect.objectContaining({ currentStep: 'implementation.build' }),
        toolPolicyMode: 'read_only'
      })
    );
  });

  it('forwards role=implementer, round=1, step=implementation.build for first implementer pass', async () => {
    const uow = makeMockUnitOfWork({ directive: 'advance' });
    const dispatcher = createReviewedExecutionDispatcher({ unitOfWork: uow });

    await dispatcher.runRole(makeRoleInput('implementer', 1));

    expect(uow.runWithCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'implementer', round: 1 })
    );
    const callArg = (uow.runWithCheckpoint as ReturnType<typeof vi.fn>).mock.calls[0][0] as RunRoleWorkInput;
    expect(callArg.run.currentStep).toBe('implementation.build');
  });

  it('forwards role=reviewer, round=1, step=implementation.build for first reviewer pass', async () => {
    const uow = makeMockUnitOfWork({ directive: 'advance' });
    const dispatcher = createReviewedExecutionDispatcher({ unitOfWork: uow });

    await dispatcher.runRole(makeRoleInput('reviewer', 1));

    expect(uow.runWithCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'reviewer', round: 1 })
    );
    const callArg = (uow.runWithCheckpoint as ReturnType<typeof vi.fn>).mock.calls[0][0] as RunRoleWorkInput;
    expect(callArg.run.currentStep).toBe('implementation.build');
  });

  it('forwards role and round for round 2 implementer pass', async () => {
    const uow = makeMockUnitOfWork({ directive: 'advance' });
    const dispatcher = createReviewedExecutionDispatcher({ unitOfWork: uow });

    await dispatcher.runRole(makeRoleInput('implementer', 2));

    expect(uow.runWithCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'implementer', round: 2 })
    );
  });

  it('forwards role and round for round 2 reviewer pass', async () => {
    const uow = makeMockUnitOfWork({ directive: 'advance' });
    const dispatcher = createReviewedExecutionDispatcher({ unitOfWork: uow });

    await dispatcher.runRole(makeRoleInput('reviewer', 2));

    expect(uow.runWithCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'reviewer', round: 2 })
    );
  });

  it('preserves runId and tenant in all forwarded calls', async () => {
    const uow = makeMockUnitOfWork({ directive: 'advance' });
    const dispatcher = createReviewedExecutionDispatcher({ unitOfWork: uow });

    await dispatcher.runRole(makeRoleInput('implementer', 1));

    expect(uow.runWithCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ runId, tenant })
    );
  });

  it('dispatch succeeds with advance result even when session persistence is delegated to unit-of-work', async () => {
    // The dispatcher itself does not perform session persistence — it delegates to the
    // unit of work. Verify that a successful advance result passes through cleanly.
    const uow = makeMockUnitOfWork({ directive: 'advance', result: { summary: 'done' } });
    const dispatcher = createReviewedExecutionDispatcher({ unitOfWork: uow });

    const result = await dispatcher.runRole(makeRoleInput('implementer', 1));

    expect(result.workResult.directive).toBe('advance');
  });

  it('dispatch propagates fail from unit-of-work when session persistence fails', async () => {
    // If the unit of work returns a fail directive (e.g. because session persistence failed),
    // the dispatcher must propagate it unchanged.
    const uow = makeMockUnitOfWork({ directive: 'fail', reason: 'session_persistence_failed' });
    const dispatcher = createReviewedExecutionDispatcher({ unitOfWork: uow });

    const result = await dispatcher.runRole(makeRoleInput('implementer', 1));

    expect(result.workResult).toEqual({ directive: 'fail', reason: 'session_persistence_failed' });
  });
});
