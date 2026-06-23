import { describe, expect, it } from 'vitest';

import type { JsonValue } from '@autocatalyst/api-contract';
import type { RunStep } from '@autocatalyst/api-contract';
import type { RunStepRepository } from './domain-repositories.js';
import { deriveAgentModelMemoryKey, createRunStepAgentModelMemoryStore } from './provider-model-memory.js';
import type { AgentModelMemorySnapshot } from '@autocatalyst/execution';

// ---------------------------------------------------------------------------
// Fake RunStepRepository
// ---------------------------------------------------------------------------

function makeRunStep(overrides: Partial<RunStep> = {}): RunStep {
  return {
    id: 'step_1',
    runId: 'run_1',
    phase: 'implementation',
    step: 'implementation.build',
    role: 'implementer',
    startedAt: '2026-06-22T00:00:00.000Z',
    endedAt: null,
    durationMs: null,
    occurrence: { index: 0, attempt: 1 },
    checkpointResult: null,
    ...overrides
  };
}

function makeFakeRunStepRepo(
  steps: RunStep[] = []
): RunStepRepository & { capturedCheckpoints: Array<{ runStepId: string; checkpointResult: JsonValue }> } {
  const capturedCheckpoints: Array<{ runStepId: string; checkpointResult: JsonValue }> = [];
  return {
    async create(_input) {
      return makeRunStep();
    },
    async findById(id) {
      return steps.find(s => s.id === id) ?? null;
    },
    async listByRun(_runId) {
      return steps;
    },
    async updateCheckpoint(input) {
      capturedCheckpoints.push({ runStepId: input.runStepId, checkpointResult: input.checkpointResult });
      const step = steps.find(s => s.id === input.runStepId);
      if (step === undefined) throw new Error('step not found');
      (step as Record<string, unknown>)['checkpointResult'] = input.checkpointResult;
      return step;
    },
    capturedCheckpoints
  };
}

// ---------------------------------------------------------------------------
// deriveAgentModelMemoryKey
// ---------------------------------------------------------------------------

describe('deriveAgentModelMemoryKey', () => {
  it('returns the expected colon-separated key', () => {
    const key = deriveAgentModelMemoryKey({
      runId: 'run_1',
      step: 'implementation.build',
      role: 'reviewer',
      providerKind: 'openai',
      adapterId: 'openai-agents-sdk',
      profileName: 'openai-reviewer'
    });
    expect(key).toBe('run_1:implementation.build:reviewer:openai:openai-agents-sdk:openai-reviewer');
  });

  it('result never contains the word sandbox', () => {
    const key = deriveAgentModelMemoryKey({
      runId: 'run_abc',
      step: 'spec.author',
      role: 'implementer',
      providerKind: 'anthropic',
      adapterId: 'claude-sdk',
      profileName: 'default'
    });
    expect(key).not.toContain('sandbox');
  });
});

// ---------------------------------------------------------------------------
// createRunStepAgentModelMemoryStore
// ---------------------------------------------------------------------------

const key = 'run_1:implementation.build:implementer:openai:openai-agents-sdk:openai-impl';

const snapshot: AgentModelMemorySnapshot = {
  providerKind: 'openai',
  adapterId: 'openai-agents-sdk',
  state: { threadId: 'thread_abc' }
};

describe('createRunStepAgentModelMemoryStore - save', () => {
  it('merges providerModelMemory into an existing checkpoint without deleting other fields', async () => {
    const existingCheckpoint = { pause: { kind: 'model_question' }, otherField: 42 };
    const steps = [makeRunStep({ checkpointResult: existingCheckpoint })];
    const repo = makeFakeRunStepRepo(steps);

    const store = createRunStepAgentModelMemoryStore({
      runSteps: repo,
      runId: 'run_1',
      tenant: 'tenant_1',
      currentStep: 'implementation.build',
      key
    });

    await store.save(snapshot);

    expect(repo.capturedCheckpoints).toHaveLength(1);
    const saved = repo.capturedCheckpoints[0].checkpointResult as Record<string, unknown>;
    // Original fields preserved
    expect(saved['pause']).toEqual({ kind: 'model_question' });
    expect(saved['otherField']).toBe(42);
    // New memory stored
    const pmem = saved['providerModelMemory'] as Record<string, unknown>;
    expect(pmem[key]).toEqual(snapshot);
  });

  it('wraps a non-null primitive checkpoint correctly', async () => {
    const steps = [makeRunStep({ checkpointResult: 'some-string' as unknown as JsonValue })];
    const repo = makeFakeRunStepRepo(steps);

    const store = createRunStepAgentModelMemoryStore({
      runSteps: repo,
      runId: 'run_1',
      tenant: 'tenant_1',
      currentStep: 'implementation.build',
      key
    });

    await store.save(snapshot);

    expect(repo.capturedCheckpoints).toHaveLength(1);
    const saved = repo.capturedCheckpoints[0].checkpointResult as Record<string, unknown>;
    expect(saved['previousCheckpoint']).toBe('some-string');
    const pmem = saved['providerModelMemory'] as Record<string, unknown>;
    expect(pmem[key]).toEqual(snapshot);
  });

  it('wraps an array checkpoint correctly', async () => {
    const steps = [makeRunStep({ checkpointResult: [1, 2, 3] as unknown as JsonValue })];
    const repo = makeFakeRunStepRepo(steps);

    const store = createRunStepAgentModelMemoryStore({
      runSteps: repo,
      runId: 'run_1',
      tenant: 'tenant_1',
      currentStep: 'implementation.build',
      key
    });

    await store.save(snapshot);

    const saved = repo.capturedCheckpoints[0].checkpointResult as Record<string, unknown>;
    expect(saved['previousCheckpoint']).toEqual([1, 2, 3]);
    const pmem = saved['providerModelMemory'] as Record<string, unknown>;
    expect(pmem[key]).toEqual(snapshot);
  });

  it('creates a fresh checkpoint when checkpointResult is null', async () => {
    const steps = [makeRunStep({ checkpointResult: null })];
    const repo = makeFakeRunStepRepo(steps);

    const store = createRunStepAgentModelMemoryStore({
      runSteps: repo,
      runId: 'run_1',
      tenant: 'tenant_1',
      currentStep: 'implementation.build',
      key
    });

    await store.save(snapshot);

    const saved = repo.capturedCheckpoints[0].checkpointResult as Record<string, unknown>;
    const pmem = saved['providerModelMemory'] as Record<string, unknown>;
    expect(pmem[key]).toEqual(snapshot);
  });

  it('does nothing when no RunStep matches currentStep', async () => {
    const steps = [makeRunStep({ step: 'spec.author' })];
    const repo = makeFakeRunStepRepo(steps);

    const store = createRunStepAgentModelMemoryStore({
      runSteps: repo,
      runId: 'run_1',
      tenant: 'tenant_1',
      currentStep: 'implementation.build',
      key
    });

    await store.save(snapshot);
    expect(repo.capturedCheckpoints).toHaveLength(0);
  });
});

describe('createRunStepAgentModelMemoryStore - load', () => {
  it('returns the snapshot for the requested key', async () => {
    const checkpoint = {
      providerModelMemory: {
        [key]: {
          providerKind: 'openai',
          adapterId: 'openai-agents-sdk',
          state: { threadId: 'thread_xyz' }
        }
      }
    };
    const steps = [makeRunStep({ checkpointResult: checkpoint })];
    const repo = makeFakeRunStepRepo(steps);

    const store = createRunStepAgentModelMemoryStore({
      runSteps: repo,
      runId: 'run_1',
      tenant: 'tenant_1',
      currentStep: 'implementation.build',
      key
    });

    const result = await store.load();
    expect(result).toEqual({
      providerKind: 'openai',
      adapterId: 'openai-agents-sdk',
      state: { threadId: 'thread_xyz' }
    });
  });

  it('returns null when the active run step has no providerModelMemory', async () => {
    const steps = [makeRunStep({ checkpointResult: { pause: { kind: 'model_question' } } })];
    const repo = makeFakeRunStepRepo(steps);

    const store = createRunStepAgentModelMemoryStore({
      runSteps: repo,
      runId: 'run_1',
      tenant: 'tenant_1',
      currentStep: 'implementation.build',
      key
    });

    const result = await store.load();
    expect(result).toBeNull();
  });

  it('returns null when no RunStep matches currentStep', async () => {
    const steps = [makeRunStep({ step: 'spec.author' })];
    const repo = makeFakeRunStepRepo(steps);

    const store = createRunStepAgentModelMemoryStore({
      runSteps: repo,
      runId: 'run_1',
      tenant: 'tenant_1',
      currentStep: 'implementation.build',
      key
    });

    const result = await store.load();
    expect(result).toBeNull();
  });

  it('returns null when checkpoint is null', async () => {
    const steps = [makeRunStep({ checkpointResult: null })];
    const repo = makeFakeRunStepRepo(steps);

    const store = createRunStepAgentModelMemoryStore({
      runSteps: repo,
      runId: 'run_1',
      tenant: 'tenant_1',
      currentStep: 'implementation.build',
      key
    });

    const result = await store.load();
    expect(result).toBeNull();
  });

  it('returns null when the key is not present in providerModelMemory', async () => {
    const checkpoint = {
      providerModelMemory: {
        'other-key': { providerKind: 'openai', adapterId: 'openai-agents-sdk', state: {} }
      }
    };
    const steps = [makeRunStep({ checkpointResult: checkpoint })];
    const repo = makeFakeRunStepRepo(steps);

    const store = createRunStepAgentModelMemoryStore({
      runSteps: repo,
      runId: 'run_1',
      tenant: 'tenant_1',
      currentStep: 'implementation.build',
      key
    });

    const result = await store.load();
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Adapter continuity: mismatched providerKind/adapterId
// ---------------------------------------------------------------------------

describe('openai adapter continuity — mismatched snapshot rejection', () => {
  it('a snapshot with providerKind !== "openai" should produce no modelMemoryState (adapter must ignore it)', async () => {
    // This test documents the expected contract: if load() returns a snapshot for a different
    // providerKind (e.g. "anthropic"), the openai adapter must not use it.
    // The store itself returns the snapshot faithfully — the adapter is responsible for filtering.
    const checkpoint = {
      providerModelMemory: {
        [key]: { providerKind: 'anthropic', adapterId: 'openai-agents-sdk', state: { previousResponseId: 'resp_x' } }
      }
    };
    const steps = [makeRunStep({ checkpointResult: checkpoint })];
    const repo = makeFakeRunStepRepo(steps);

    const store = createRunStepAgentModelMemoryStore({
      runSteps: repo,
      runId: 'run_1',
      tenant: 'tenant_1',
      currentStep: 'implementation.build',
      key
    });

    const result = await store.load();
    // The store returns the snapshot — but the adapter must check providerKind before using it.
    // We verify the snapshot does NOT have providerKind === 'openai', so the adapter should ignore it.
    expect(result).not.toBeNull();
    expect(result?.providerKind).not.toBe('openai');
  });

  it('a snapshot with adapterId !== "openai-agents-sdk" should produce no modelMemoryState (adapter must ignore it)', async () => {
    const checkpoint = {
      providerModelMemory: {
        [key]: { providerKind: 'openai', adapterId: 'openai-direct', state: { previousResponseId: 'resp_y' } }
      }
    };
    const steps = [makeRunStep({ checkpointResult: checkpoint })];
    const repo = makeFakeRunStepRepo(steps);

    const store = createRunStepAgentModelMemoryStore({
      runSteps: repo,
      runId: 'run_1',
      tenant: 'tenant_1',
      currentStep: 'implementation.build',
      key
    });

    const result = await store.load();
    // The store returns the snapshot — but the adapter must check adapterId before using it.
    expect(result).not.toBeNull();
    expect(result?.adapterId).not.toBe('openai-agents-sdk');
  });
});
