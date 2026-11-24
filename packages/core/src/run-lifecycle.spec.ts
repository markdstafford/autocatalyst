import { describe, expect, it, vi } from 'vitest';

import type {
  RecordRunLifecycleStartInput,
  RecordRunLifecycleStartResult,
  RecordRunStepTransitionInput,
  RecordRunStepTransitionResult,
  RunRepository
} from './domain-repositories.js';
import { runWorkflows } from './run-workflows.js';
import { applyRunDirective, startRunLifecycle } from './run-lifecycle.js';
import type { Run, RunStep } from '@autocatalyst/api-contract';

const owner = { id: 'user_1', kind: 'human' as const, tenantId: 'tenant_1', displayName: 'Ada' };

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run_1',
    topicId: 'topic_1',
    owner,
    tenant: 'tenant_1',
    workKind: 'feature',
    currentStep: 'intake',
    terminal: false,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides
  };
}

function makeRunStep(overrides: Partial<RunStep> = {}): RunStep {
  return {
    id: 'step_1',
    runId: 'run_1',
    phase: null,
    step: 'intake',
    role: 'none',
    startedAt: '2024-01-01T00:00:00.000Z',
    endedAt: null,
    durationMs: null,
    occurrence: { index: 0, attempt: 1 },
    checkpointResult: null,
    ...overrides
  };
}

function makeRunRepository(overrides: Partial<RunRepository> = {}): RunRepository {
  return {
    create: () => Promise.reject(new Error('not implemented')),
    findById: () => Promise.resolve(null),
    findActiveByTopic: () => Promise.resolve(null),
    listByTopic: () => Promise.resolve([]),
    listByTenant: () => Promise.resolve({ runs: [] }),
    recordRunLifecycleStart: () => Promise.reject(new Error('not implemented')),
    recordRunStepTransition: () => Promise.reject(new Error('not implemented')),
    ...overrides
  };
}

describe('startRunLifecycle', () => {
  it('starts a feature run at intake', async () => {
    const run = makeRun();
    const runStep = makeRunStep();
    const repos = makeRunRepository({
      recordRunLifecycleStart: async (input: RecordRunLifecycleStartInput): Promise<RecordRunLifecycleStartResult> => {
        expect(input.run.currentStep).toBe('intake');
        expect(input.run.terminal).toBe(false);
        expect(input.runStep.step).toBe('intake');
        expect(input.runStep.phase).toBeNull();
        expect(input.runStep.role).toBe('none');
        return { run, runStep };
      }
    });

    const state = await startRunLifecycle({
      runs: repos,
      run: { topicId: 'topic_1', owner, tenant: 'tenant_1', workKind: 'feature' }
    });

    expect(state.run.currentStep).toBe('intake');
    expect(state.workflow.id).toBe('feature');
    expect(state.step.id).toBe('intake');
    expect(state.runStep.id).toBe('step_1');
    expect(state.transition).toBeUndefined();
  });

  it('rejects unknown workKind', async () => {
    const repos = makeRunRepository();

    await expect(startRunLifecycle({
      runs: repos,
      run: { topicId: 'topic_1', owner, tenant: 'tenant_1', workKind: 'custom_unknown' }
    })).rejects.toMatchObject({ code: 'unknown_work_kind' });
  });

  it('wraps persistence failure as start_persistence_failed', async () => {
    const repos = makeRunRepository({
      recordRunLifecycleStart: async () => { throw new Error('db error'); }
    });

    await expect(startRunLifecycle({
      runs: repos,
      run: { topicId: 'topic_1', owner, tenant: 'tenant_1', workKind: 'feature' }
    })).rejects.toMatchObject({ code: 'start_persistence_failed' });
  });
});

describe('applyRunDirective', () => {
  it('advances from intake to spec.author', async () => {
    const run = makeRun();
    const nextRun = makeRun({ currentStep: 'spec.author' });
    const nextStep = makeRunStep({ step: 'spec.author', phase: 'spec', occurrence: { index: 1, attempt: 1 } });

    const repos = makeRunRepository({
      findById: async () => run,
      recordRunStepTransition: async (input: RecordRunStepTransitionInput): Promise<RecordRunStepTransitionResult> => {
        expect(input.currentStep).toBe('spec.author');
        expect(input.terminal).toBe(false);
        expect(input.runStep.step).toBe('spec.author');
        expect(input.runStep.phase).toBe('spec');
        expect(input.runStep.role).toBe('none');
        return { run: nextRun, runStep: nextStep };
      }
    });

    const state = await applyRunDirective({
      runs: repos,
      runId: 'run_1',
      directive: 'advance'
    });

    expect(state.run.currentStep).toBe('spec.author');
    expect(state.step.id).toBe('spec.author');
    expect(state.runStep.occurrence.index).toBe(1);
    expect(state.transition?.ok).toBe(true);
    expect(state.transition?.to).toBe('spec.author');
  });

  it('rejects missing run', async () => {
    const repos = makeRunRepository({ findById: async () => null });

    await expect(applyRunDirective({
      runs: repos,
      runId: 'run_missing',
      directive: 'advance'
    })).rejects.toMatchObject({ code: 'missing_run' });
  });

  it('rejects terminal run', async () => {
    const repos = makeRunRepository({
      findById: async () => makeRun({ currentStep: 'done', terminal: true })
    });

    await expect(applyRunDirective({
      runs: repos,
      runId: 'run_1',
      directive: 'advance'
    })).rejects.toMatchObject({ code: 'terminal_run' });
  });

  it('rejects invalid transition with transitionCode detail', async () => {
    const repos = makeRunRepository({
      findById: async () => makeRun({ currentStep: 'intake' })
    });

    await expect(applyRunDirective({
      runs: repos,
      runId: 'run_1',
      directive: 'revise'
    })).rejects.toMatchObject({ code: 'invalid_transition', transitionCode: 'missing_edge' });
  });

  it('wraps persistence failure as transition_persistence_failed', async () => {
    const repos = makeRunRepository({
      findById: async () => makeRun({ currentStep: 'intake' }),
      recordRunStepTransition: async () => { throw new Error('db error'); }
    });

    await expect(applyRunDirective({
      runs: repos,
      runId: 'run_1',
      directive: 'advance'
    })).rejects.toMatchObject({ code: 'transition_persistence_failed' });
  });

  it('forwards reason as failureReason for fail transitions', async () => {
    let lastTransitionInput: RecordRunStepTransitionInput | undefined;
    const run = makeRun({ currentStep: 'spec.author' });
    const failedRun = makeRun({ currentStep: 'failed', terminal: true });
    const failedStep = makeRunStep({ step: 'failed' });

    const repos = makeRunRepository({
      findById: async () => run,
      recordRunStepTransition: async (input: RecordRunStepTransitionInput): Promise<RecordRunStepTransitionResult> => {
        lastTransitionInput = input;
        return { run: failedRun, runStep: failedStep };
      }
    });

    await applyRunDirective({
      runs: repos,
      runId: 'run_1',
      directive: 'fail',
      reason: 'provider_auth_failed',
      clock: () => '2026-06-13T00:00:00.000Z'
    });

    expect(lastTransitionInput?.failureReason).toBe('provider_auth_failed');
  });

  it('omits failureReason for non-fail transitions', async () => {
    let lastTransitionInput: RecordRunStepTransitionInput | undefined;
    const run = makeRun({ currentStep: 'intake' });
    const nextRun = makeRun({ currentStep: 'spec.author' });
    const nextStep = makeRunStep({ step: 'spec.author' });

    const repos = makeRunRepository({
      findById: async () => run,
      recordRunStepTransition: async (input: RecordRunStepTransitionInput): Promise<RecordRunStepTransitionResult> => {
        lastTransitionInput = input;
        return { run: nextRun, runStep: nextStep };
      }
    });

    await applyRunDirective({
      runs: repos,
      runId: 'run_1',
      directive: 'advance',
      reason: 'provider_auth_failed',
      clock: () => '2026-06-13T00:00:00.000Z'
    });

    expect(lastTransitionInput?.failureReason).toBeUndefined();
  });

  it('does not inherit legacy providerModelMemory into a new RunStep', async () => {
    let capturedTransitionInput: RecordRunStepTransitionInput | undefined;
    const run = makeRun({ currentStep: 'implementation.build' });
    const nextRun = makeRun({ currentStep: 'implementation.awaiting_input' });
    const nextStep = makeRunStep({ step: 'implementation.awaiting_input' });
    const sourceRunStep = makeRunStep({
      id: 'step_source',
      step: 'implementation.build',
      checkpointResult: {
        providerModelMemory: {
          'run_1:implementation.build:implementer:openai:openai-agents-sdk:default': {
            providerKind: 'openai',
            adapterId: 'openai-agents-sdk',
            state: { previousResponseId: 'resp_turn1' }
          }
        }
      }
    });

    const repos = makeRunRepository({
      findById: async () => run,
      findLatestOpenRunStep: async () => sourceRunStep,
      recordRunStepTransition: async (input: RecordRunStepTransitionInput): Promise<RecordRunStepTransitionResult> => {
        capturedTransitionInput = input;
        return { run: nextRun, runStep: nextStep };
      }
    });

    await applyRunDirective({
      runs: repos,
      runId: 'run_1',
      directive: 'needs_input',
      checkpointResult: { convergenceResult: 'paused' }
    });

    expect(capturedTransitionInput).not.toHaveProperty('inheritedProviderModelMemory');
    expect(capturedTransitionInput?.sourceRunStepId).toBe('step_source');
    expect(capturedTransitionInput?.checkpointResult).toEqual({ convergenceResult: 'paused' });
  });


});

describe('checked workflow resolution', () => {
  const invalid = { ...runWorkflows.feature, phases: [] };

  it('does not record an entry step for an invalid definition', async () => {
    const recordRunLifecycleStart = vi.fn();
    const workflowResolver = vi.fn().mockResolvedValue(invalid);
    await expect(startRunLifecycle({
      runs: makeRunRepository({ recordRunLifecycleStart }),
      run: { owner, topicId: 'topic_1', tenant: owner.tenantId, workKind: 'feature' },
      workflowResolver
    })).rejects.toMatchObject({ code: 'unknown_workflow' });
    expect(workflowResolver).toHaveBeenCalledWith({
      kind: 'existing_topic', topicId: 'topic_1', tenant: owner.tenantId, workKind: 'feature'
    });
    expect(recordRunLifecycleStart).not.toHaveBeenCalled();
  });

  it.each([
    [invalid, 'unknown_workflow'],
    [null, 'unknown_work_kind']
  ] as const)('does not record a transition on resolution failure (%s)', async (definition, code) => {
    const run = makeRun();
    const recordRunStepTransition = vi.fn();
    const workflowResolver = vi.fn().mockResolvedValue(definition);
    await expect(applyRunDirective({
      runs: makeRunRepository({ findById: async () => run, recordRunStepTransition }),
      runId: run.id, directive: 'advance', workflowResolver
    })).rejects.toMatchObject({ code });
    expect(workflowResolver).toHaveBeenCalledWith({ kind: 'existing_run', run });
    expect(recordRunStepTransition).not.toHaveBeenCalled();
  });

  it.each([['cancel', 'canceled'], ['fail', 'failed']] as const)('%s resolves and preserves stop results', async (directive, to) => {
    const run = makeRun({ currentStep: 'spec.awaiting_input' });
    const stopped = makeRun({ currentStep: to, terminal: true });
    const runStep = makeRunStep({ step: to });
    const recordRunStepTransition = vi.fn().mockResolvedValue({ run: stopped, runStep });
    const workflowResolver = vi.fn().mockReturnValue(runWorkflows.feature);
    const result = await applyRunDirective({
      runs: makeRunRepository({ findById: async () => run, recordRunStepTransition }),
      runId: run.id, directive, workflowResolver
    });
    expect(workflowResolver).toHaveBeenCalledExactlyOnceWith({ kind: 'existing_run', run });
    expect(result).toEqual({
      run: stopped, runStep, workflow: runWorkflows.feature,
      step: { id: to, phase: null, waitingOn: 'none', roles: [], kind: 'terminal' },
      transition: { ok: true, workflowId: 'feature', from: run.currentStep, directive, to }
    });
    expect(recordRunStepTransition).toHaveBeenCalledWith(expect.objectContaining({ currentStep: to, terminal: true }));
  });

  it.each(['cancel', 'fail'] as const)('%s retains membership and terminal guards', async (directive) => {
    for (const [currentStep, transitionCode] of [
      ['docs.update', 'step_not_in_workflow'],
      ['done', 'terminal_step']
    ] as const) {
      // A real terminal run is caught by terminal_run first; use a stale flag to
      // exercise nextWorkflowStep's independent catalog-based guard.
      const run = makeRun({ currentStep });
      const recordRunStepTransition = vi.fn();
      const workflowResolver = vi.fn().mockReturnValue(runWorkflows.feature);
      await expect(applyRunDirective({
        runs: makeRunRepository({ findById: async () => run, recordRunStepTransition }),
        runId: run.id, directive, workflowResolver
      })).rejects.toMatchObject({ code: 'invalid_transition', transitionCode });
      expect(workflowResolver).toHaveBeenCalledExactlyOnceWith({ kind: 'existing_run', run });
      expect(recordRunStepTransition).not.toHaveBeenCalled();
    }
  });
});
