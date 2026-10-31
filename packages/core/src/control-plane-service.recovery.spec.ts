import { describe, expect, it, vi } from 'vitest';
import type { Principal, Run, RunStep } from '@autocatalyst/api-contract';

import { ControlPlaneServiceError, DefaultControlPlaneService } from './control-plane-service.js';
import type { RunRepository, RunStepRepository } from './domain-repositories.js';
import type { Orchestrator } from './orchestrator.js';
import { permissivePolicyDecisionPoint, type PolicyDecisionPoint } from './policy.js';
import { InMemoryRunEventBus } from './run-events.js';
import type { RunRecoveryDependencies } from './run-recovery.js';
import { RunRecoveryWorkspaceError } from './run-recovery.js';

const ts = '2026-10-28T00:00:00.000Z';
const owner = { id: 'user_1', kind: 'human' as const, tenantId: 'tenant_1', displayName: 'Ada' };
const principal: Principal = owner;
const modelPrincipal: Principal = { kind: 'model', id: 'model_1', tenantId: 'tenant_1' };

function makeRun(overrides?: Partial<Run>): Run {
  return {
    id: 'run_1', topicId: 'topic_1', owner, tenant: 'tenant_1', workKind: 'feature',
    currentStep: 'failed', terminal: true, failureReason: 'provider_auth_failed',
    createdAt: ts, updatedAt: ts, ...overrides
  };
}

function runStep(stepId: string, overrides?: Partial<RunStep>): RunStep {
  return {
    id: `step_${stepId}`, runId: 'run_1', phase: null, step: stepId, role: 'none',
    startedAt: ts, endedAt: ts, durationMs: 0, occurrence: { index: 0, attempt: 1 },
    checkpointResult: null, ...overrides
  };
}

const failedImplHistory: RunStep[] = [
  runStep('implementation.build', { phase: 'implementation', role: 'implementer', occurrence: { index: 0, attempt: 1 } }),
  runStep('failed', { occurrence: { index: 1, attempt: 1 }, endedAt: null })
];

function makeRecovery(overrides?: Partial<RunRecoveryDependencies>): RunRecoveryDependencies {
  return {
    detectCommittedCheckpoints: vi.fn().mockResolvedValue(true),
    materializeWorkspace: vi.fn().mockResolvedValue({ provisioningOutcome: 'materialized' }),
    ...overrides
  };
}

function makeService(options?: {
  run?: Run | null;
  steps?: readonly RunStep[];
  policy?: PolicyDecisionPoint;
  recovery?: RunRecoveryDependencies;
  recoverFailedRun?: RunRepository['recoverFailedRun'];
  admitForDispatch?: Orchestrator['admitForDispatch'];
}) {
  const reopenedRun = makeRun({ currentStep: 'implementation.build', terminal: false, failureReason: undefined });
  const recoverFailedRun = options?.recoverFailedRun
    ?? vi.fn().mockResolvedValue({ run: reopenedRun, runStep: runStep('implementation.build', { phase: 'implementation', endedAt: null }) });
  const admitForDispatch = options?.admitForDispatch ?? vi.fn().mockResolvedValue(undefined);

  const runs = {
    create: vi.fn(),
    findById: vi.fn().mockResolvedValue(options?.run === undefined ? makeRun() : options.run),
    findActiveByTopic: vi.fn().mockResolvedValue(null),
    listByTopic: vi.fn().mockResolvedValue([]),
    listByTenant: vi.fn().mockResolvedValue([]),
    recordRunLifecycleStart: vi.fn(),
    recordRunStepTransition: vi.fn(),
    recoverFailedRun
  } as unknown as RunRepository;

  const runSteps = {
    create: vi.fn(),
    findById: vi.fn(),
    listByRun: vi.fn().mockResolvedValue(options?.steps ?? failedImplHistory)
  } as unknown as RunStepRepository;

  const orchestrator = { admitForDispatch } as unknown as Orchestrator;

  const service = new DefaultControlPlaneService({
    orchestrator,
    runs,
    runSteps,
    events: new InMemoryRunEventBus(),
    policy: options?.policy ?? permissivePolicyDecisionPoint,
    artifacts: { create: vi.fn(), findById: vi.fn(), listByRun: vi.fn(), findByRunAndKind: vi.fn(), updateCachedStatus: vi.fn() },
    feedback: { create: vi.fn(), findById: vi.fn(), listByRun: vi.fn(), updateStatusAndAppendThread: vi.fn(), appendThreadEntry: vi.fn() },
    runWorkspaceMetadata: { upsert: vi.fn(), findByRunId: vi.fn().mockResolvedValue(null) },
    workspaceFilesystem: { writeFile: vi.fn(), readFile: vi.fn() },
    feedbackLifecycle: { feedback: { create: vi.fn(), findById: vi.fn(), listByRun: vi.fn(), updateStatusAndAppendThread: vi.fn(), appendThreadEntry: vi.fn() }, ids: () => 'id_1', clock: () => ts },
    projects: { create: vi.fn(), findById: vi.fn(), list: vi.fn(), update: vi.fn() },
    issueReferenceIntakeResolver: { resolve: vi.fn() },
    pullRequests: { create: vi.fn(), findById: vi.fn(), findByRun: vi.fn(), updateState: vi.fn(), listOpen: vi.fn() },
    sessions: { create: vi.fn(), findById: vi.fn(), listByRun: vi.fn() },
    recovery: options?.recovery ?? makeRecovery()
  });

  return { service, recoverFailedRun, admitForDispatch };
}

async function expectConflict(promise: Promise<unknown>, messageMatch?: RegExp): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code: 'conflict' });
  if (messageMatch !== undefined) {
    await promise.catch((e: ControlPlaneServiceError) => expect(e.message).toMatch(messageMatch));
  }
}

describe('DefaultControlPlaneService.recoverRun', () => {
  it('resumes an implementation failure with committed checkpoints (omitted mode)', async () => {
    const recovery = makeRecovery();
    const { service, recoverFailedRun, admitForDispatch } = makeService({ recovery });
    const result = await service.recoverRun({ principal, tenant: 'tenant_1', runId: 'run_1', request: {} });

    expect(result.mode).toBe('resume');
    expect(result.run.currentStep).toBe('implementation.build');
    expect(recovery.materializeWorkspace).toHaveBeenCalledWith(expect.objectContaining({ baseKind: 'run_branch', existingWorkspaceBehavior: 'keep' }));
    expect(recoverFailedRun).toHaveBeenCalledWith(expect.objectContaining({ reDispatchStep: 'implementation.build' }));
    expect(admitForDispatch).toHaveBeenCalledWith({ runId: 'run_1', tenant: 'tenant_1' });
  });

  it('starts over a spec failure at spec.author (omitted mode) without consulting commit detection', async () => {
    const recovery = makeRecovery();
    const steps: RunStep[] = [
      runStep('spec.author', { phase: 'spec', occurrence: { index: 0, attempt: 1 } }),
      runStep('failed', { occurrence: { index: 1, attempt: 1 }, endedAt: null })
    ];
    const { service, recoverFailedRun } = makeService({ recovery, steps });
    const result = await service.recoverRun({ principal, tenant: 'tenant_1', runId: 'run_1', request: {} });

    expect(result.mode).toBe('start_over');
    expect(recovery.detectCommittedCheckpoints).not.toHaveBeenCalled();
    expect(recovery.materializeWorkspace).toHaveBeenCalledWith(expect.objectContaining({ baseKind: 'current_default_branch', existingWorkspaceBehavior: 'replace' }));
    expect(recoverFailedRun).toHaveBeenCalledWith(expect.objectContaining({ reDispatchStep: 'spec.author' }));
  });

  it('honors explicit resume for a spec failure', async () => {
    const steps: RunStep[] = [
      runStep('spec.author', { phase: 'spec', occurrence: { index: 0, attempt: 1 } }),
      runStep('failed', { occurrence: { index: 1, attempt: 1 }, endedAt: null })
    ];
    const recovery = makeRecovery();
    const { service } = makeService({ recovery, steps });
    const result = await service.recoverRun({ principal, tenant: 'tenant_1', runId: 'run_1', request: { mode: 'resume' } });
    expect(result.mode).toBe('resume');
    expect(recovery.detectCommittedCheckpoints).not.toHaveBeenCalled();
  });

  it('honors explicit start_over for an implementation failure', async () => {
    const { service } = makeService();
    const result = await service.recoverRun({ principal, tenant: 'tenant_1', runId: 'run_1', request: { mode: 'start_over' } });
    expect(result.mode).toBe('start_over');
  });

  it('materializes the workspace before reopening the run', async () => {
    const order: string[] = [];
    const recovery = makeRecovery({
      materializeWorkspace: vi.fn().mockImplementation(async () => { order.push('materialize'); return { provisioningOutcome: 'materialized' as const }; })
    });
    const recoverFailedRun = vi.fn().mockImplementation(async () => {
      order.push('reopen');
      return { run: makeRun({ currentStep: 'implementation.build', terminal: false, failureReason: undefined }), runStep: runStep('implementation.build', { endedAt: null }) };
    });
    const { service } = makeService({ recovery, recoverFailedRun });
    await service.recoverRun({ principal, tenant: 'tenant_1', runId: 'run_1', request: {} });
    expect(order).toEqual(['materialize', 'reopen']);
  });

  it('returns 404 for a missing run', async () => {
    const { service } = makeService({ run: null });
    await expect(service.recoverRun({ principal, tenant: 'tenant_1', runId: 'run_x', request: {} }))
      .rejects.toMatchObject({ code: 'not_found' });
  });

  it('returns 404 for a cross-tenant run', async () => {
    const { service } = makeService({ run: makeRun({ tenant: 'tenant_other' }) });
    await expect(service.recoverRun({ principal, tenant: 'tenant_1', runId: 'run_1', request: {} }))
      .rejects.toMatchObject({ code: 'not_found' });
  });

  it('rejects a model principal with forbidden/unauthorized', async () => {
    const { service } = makeService();
    await expect(service.recoverRun({ principal: modelPrincipal, tenant: 'tenant_1', runId: 'run_1', request: {} }))
      .rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('rejects a denied policy decision with forbidden', async () => {
    const { service } = makeService({ policy: { authorize: vi.fn().mockResolvedValue({ allowed: false }) } });
    await expect(service.recoverRun({ principal, tenant: 'tenant_1', runId: 'run_1', request: {} }))
      .rejects.toMatchObject({ code: 'forbidden' });
  });

  it('returns 409 for a canceled run', async () => {
    const { service } = makeService({ run: makeRun({ currentStep: 'canceled', failureReason: undefined }) });
    await expectConflict(service.recoverRun({ principal, tenant: 'tenant_1', runId: 'run_1', request: {} }), /canceled/);
  });

  it('returns 409 for a done run', async () => {
    const { service } = makeService({ run: makeRun({ currentStep: 'done', failureReason: undefined }) });
    await expectConflict(service.recoverRun({ principal, tenant: 'tenant_1', runId: 'run_1', request: {} }), /done/);
  });

  it('returns 409 for a non-terminal run', async () => {
    const { service } = makeService({ run: makeRun({ currentStep: 'implementation.build', terminal: false, failureReason: undefined }) });
    await expectConflict(service.recoverRun({ principal, tenant: 'tenant_1', runId: 'run_1', request: {} }));
  });

  it('returns 409 when no stopped step can be determined', async () => {
    const { service } = makeService({ steps: [runStep('failed', { endedAt: null })] });
    await expectConflict(service.recoverRun({ principal, tenant: 'tenant_1', runId: 'run_1', request: {} }));
  });

  it('maps run_branch_missing to a 409 and does not reopen the run', async () => {
    const recovery = makeRecovery({
      materializeWorkspace: vi.fn().mockRejectedValue(new RunRecoveryWorkspaceError('run_branch_missing', 'missing'))
    });
    const { service, recoverFailedRun } = makeService({ recovery });
    await expectConflict(service.recoverRun({ principal, tenant: 'tenant_1', runId: 'run_1', request: { mode: 'resume' } }), /run_branch_missing/);
    expect(recoverFailedRun).not.toHaveBeenCalled();
  });

  it('maps an active-run conflict to active_run_conflict', async () => {
    const conflict = new Error('Active run conflict');
    conflict.name = 'ActiveRunConflictPersistenceError';
    const recoverFailedRun = vi.fn().mockRejectedValue(conflict);
    const { service } = makeService({ recoverFailedRun });
    await expect(service.recoverRun({ principal, tenant: 'tenant_1', runId: 'run_1', request: {} }))
      .rejects.toMatchObject({ code: 'active_run_conflict' });
  });
});
