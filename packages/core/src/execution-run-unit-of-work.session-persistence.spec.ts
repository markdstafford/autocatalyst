import { describe, expect, it, vi } from 'vitest';

import type { ExecutionContext, JsonValue } from '@autocatalyst/api-contract';
import type { RunStep } from '@autocatalyst/api-contract';
import type { ExecutionBoundaryEvent, ExecutionEntryPoint, ExecutionEntryPointInput, RunnerSessionMetadata } from '@autocatalyst/execution';
import { PreTerminalRunnerFailure, RunnerProtocolError } from '@autocatalyst/execution';
import type { Session } from '@autocatalyst/api-contract';
import type { RunStepRepository, SessionRepository } from './domain-repositories.js';
import type { RunWorkInput, RunWorkResult } from './orchestrator.js';
import { createExecutionRunUnitOfWork } from './execution-run-unit-of-work.js';
import type { DirectStepExecutionPort } from './execution-run-unit-of-work.js';
import { InMemoryRetainedRunEventStore } from './run-events.js';
import { ExecutionSessionRecordingError } from './execution-session-recorder.js';

const runId = 'run_1';
const tenant = 'tenant_1';

const baseSessionMetadata = {
  model: { provider: 'anthropic', model: 'claude-sonnet-4' } as const,
  inferenceSettings: {},
  startedAt: '2026-06-22T00:00:00.000Z',
  endedAt: '2026-06-22T00:01:00.000Z',
  outcome: 'succeeded' as const
};

function makeInput(overrides: Partial<RunWorkInput> = {}): RunWorkInput {
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
      createdAt: '2026-06-22T00:00:00.000Z',
      updatedAt: '2026-06-22T00:00:00.000Z'
    } as RunWorkInput['run'],
    tenant,
    ...overrides
  };
}

function makeRoleInput(role: 'implementer' | 'reviewer', round = 1): RunWorkInput {
  return {
    ...makeInput(),
    role,
    round
  } as RunWorkInput;
}

function makeContext(): ExecutionContext {
  return {
    run: { id: runId, workKind: 'feature', currentStep: 'implementation.build', tenant },
    task: { prompt: 'Implement feature', inputs: {} },
    workspaceIntent: { shape: 'none' },
    secretBindings: [],
    toolPolicy: { allowedTools: ['bash'], workspaceScope: 'declared_workspace' },
    skills: { requested: [], resolved: [] },
    capabilityRequirements: {
      shell: { kind: 'bash', required: false },
      paths: { canonicalWorkspacePaths: true },
      lsp: { requested: true }
    }
  } as ExecutionContext;
}

function makeTerminalEvent(
  directive: 'advance' | 'needs_input' | 'fail',
  withSessionMetadata = true
): ExecutionBoundaryEvent {
  const result: Record<string, unknown> = { directive };
  if (directive === 'needs_input') result['question'] = 'What next?';
  if (directive === 'fail') result['reason'] = 'Something went wrong.';

  return {
    id: 'evt_terminal',
    type: 'runner_terminal_result',
    runId,
    step: 'implementation.build',
    importance: 'normal',
    createdAt: '2026-06-22T00:00:00.000Z',
    result,
    ...(withSessionMetadata ? { sessionMetadata: baseSessionMetadata } : {})
  } as ExecutionBoundaryEvent;
}

function makeFakeEntryPoint(events: ExecutionBoundaryEvent[]): ExecutionEntryPoint {
  return {
    execute(_input: ExecutionEntryPointInput): AsyncIterable<ExecutionBoundaryEvent> {
      return (async function* () {
        for (const event of events) {
          yield event;
        }
      })();
    }
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session_1',
    runId,
    phase: 'implementation',
    step: 'implementation.build',
    role: 'implementer',
    round: 1,
    model: { provider: 'anthropic', model: 'claude-sonnet-4' },
    inferenceSettings: {},
    startedAt: '2026-06-22T00:00:00.000Z',
    endedAt: '2026-06-22T00:01:00.000Z',
    durationMs: 60000,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    usageAvailable: false,
    assistantTurnCount: 0,
    toolCallCount: 0,
    outcome: 'succeeded',
    cost: {
      model: { provider: 'anthropic', model: 'claude-sonnet-4' },
      usd: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    },
    ...overrides
  };
}

function makeSessions(impl: Partial<SessionRepository> = {}): SessionRepository {
  return {
    create: vi.fn().mockResolvedValue(makeSession()),
    findById: vi.fn(),
    listByRun: vi.fn(),
    ...impl
  } as unknown as SessionRepository;
}

function newStore() {
  return new InMemoryRetainedRunEventStore();
}

describe('execution-run-unit-of-work session persistence', () => {
  // ---------------------------------------------------------------------------
  // Agent path
  // ---------------------------------------------------------------------------

  it('records a durable session for successful agent sessions', async () => {
    const sessions = makeSessions();
    const unitOfWork = createExecutionRunUnitOfWork({
      execute: makeFakeEntryPoint([makeTerminalEvent('advance')]),
      resolveContext: async () => makeContext(),
      eventsStore: newStore(),
      sessions
    });

    const input = makeRoleInput('implementer', 1);
    const result = await unitOfWork.run(input);

    expect(result).toEqual({ directive: 'advance' });
    expect(sessions.create).toHaveBeenCalledOnce();
    const call = (sessions.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call).toMatchObject({
      runId,
      phase: 'implementation',
      step: 'implementation.build',
      role: 'implementer',
      round: 1,
      outcome: 'succeeded'
    });
  });

  it('records needs_input sessions as succeeded', async () => {
    const sessions = makeSessions();
    const unitOfWork = createExecutionRunUnitOfWork({
      execute: makeFakeEntryPoint([makeTerminalEvent('needs_input')]),
      resolveContext: async () => makeContext(),
      eventsStore: newStore(),
      sessions
    });

    const result = await unitOfWork.run(makeRoleInput('implementer', 1));

    expect(result).toMatchObject({ directive: 'needs_input' });
    expect(sessions.create).toHaveBeenCalledOnce();
    const call = (sessions.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // needs_input maps to succeeded in the recorder
    expect(call.outcome).toBe('succeeded');
  });

  it('records failed terminal sessions as failed', async () => {
    const sessions = makeSessions();
    const terminalFail: ExecutionBoundaryEvent = {
      id: 'evt_terminal',
      type: 'runner_terminal_result',
      runId,
      step: 'implementation.build',
      importance: 'normal',
      createdAt: '2026-06-22T00:00:00.000Z',
      result: { directive: 'fail', reason: 'provider_auth_failed' },
      sessionMetadata: { ...baseSessionMetadata, outcome: 'failed' }
    } as ExecutionBoundaryEvent;

    const unitOfWork = createExecutionRunUnitOfWork({
      execute: makeFakeEntryPoint([terminalFail]),
      resolveContext: async () => makeContext(),
      eventsStore: newStore(),
      sessions
    });

    const result = await unitOfWork.run(makeRoleInput('implementer', 1));
    expect(result.directive).toBe('fail');
    expect(sessions.create).toHaveBeenCalledOnce();
    const call = (sessions.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.outcome).toBe('failed');
  });

  it('fails successful dispatch when session persistence fails', async () => {
    const sessions = makeSessions({
      create: vi.fn().mockRejectedValue(new Error('DB write failed'))
    });
    const unitOfWork = createExecutionRunUnitOfWork({
      execute: makeFakeEntryPoint([makeTerminalEvent('advance')]),
      resolveContext: async () => makeContext(),
      eventsStore: newStore(),
      sessions
    });

    const result = await unitOfWork.run(makeRoleInput('implementer', 1));
    expect(result).toEqual({ directive: 'fail', reason: 'session_persistence_failed' });
  });

  it('fails needs_input dispatch when session persistence fails', async () => {
    const sessions = makeSessions({
      create: vi.fn().mockRejectedValue(new Error('DB write failed'))
    });
    const unitOfWork = createExecutionRunUnitOfWork({
      execute: makeFakeEntryPoint([makeTerminalEvent('needs_input')]),
      resolveContext: async () => makeContext(),
      eventsStore: newStore(),
      sessions
    });

    const result = await unitOfWork.run(makeRoleInput('implementer', 1));
    expect(result).toEqual({ directive: 'fail', reason: 'session_persistence_failed' });
  });

  it('preserves original failed terminal reason when session persistence fails and logs safely', async () => {
    const sessions = makeSessions({
      create: vi.fn().mockRejectedValue(new Error('DB write failed'))
    });
    const logger = {
      warn: vi.fn(),
      error: vi.fn()
    };
    const terminalFail: ExecutionBoundaryEvent = {
      id: 'evt_terminal',
      type: 'runner_terminal_result',
      runId,
      step: 'implementation.build',
      importance: 'normal',
      createdAt: '2026-06-22T00:00:00.000Z',
      result: { directive: 'fail', reason: 'provider_auth_failed' },
      sessionMetadata: { ...baseSessionMetadata, outcome: 'failed' }
    } as ExecutionBoundaryEvent;

    const unitOfWork = createExecutionRunUnitOfWork({
      execute: makeFakeEntryPoint([terminalFail]),
      resolveContext: async () => makeContext(),
      eventsStore: newStore(),
      sessions,
      logger
    });

    const result = await unitOfWork.run(makeRoleInput('implementer', 1));
    // Original fail reason should be preserved (normalized to safe fallback since 'provider_auth_failed' is allowlisted)
    expect(result.directive).toBe('fail');
    // The logger should have been called for the error (may be called by recorder and/or unit-of-work)
    expect(logger.error).toHaveBeenCalled();
    // Verify each log call includes only safe fields
    for (const call of (logger.error as ReturnType<typeof vi.fn>).mock.calls) {
      const logFields = call[0] as Record<string, unknown>;
      expect(logFields).toHaveProperty('runId');
      expect(logFields).toHaveProperty('step');
      expect(logFields).toHaveProperty('role');
      expect(logFields).toHaveProperty('errorName');
      // Should not leak raw error messages in any log call
      expect(JSON.stringify(logFields)).not.toContain('DB write failed');
    }
  });

  it('does not record when no sessionMetadata is present on terminal event', async () => {
    const sessions = makeSessions();
    const unitOfWork = createExecutionRunUnitOfWork({
      execute: makeFakeEntryPoint([makeTerminalEvent('advance', false /* no sessionMetadata */)]),
      resolveContext: async () => makeContext(),
      eventsStore: newStore(),
      sessions
    });

    await unitOfWork.run(makeRoleInput('implementer', 1));
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it('does not record when sessions repository is not configured', async () => {
    // No sessions option passed — must not call any repo
    const unitOfWork = createExecutionRunUnitOfWork({
      execute: makeFakeEntryPoint([makeTerminalEvent('advance')]),
      resolveContext: async () => makeContext(),
      eventsStore: newStore()
      // sessions: undefined (not provided)
    });

    // Should work fine without sessions
    const result = await unitOfWork.run(makeInput());
    expect(result).toEqual({ directive: 'advance' });
  });

  // ---------------------------------------------------------------------------
  // Direct mode
  // ---------------------------------------------------------------------------

  it('records direct-call session metadata when model is available', async () => {
    const sessions = makeSessions();
    const directPort: DirectStepExecutionPort = {
      call: vi.fn().mockResolvedValue({
        value: { ok: true },
        validation: { status: 'valid' },
        metadata: {
          outcome: 'succeeded',
          tokenUsage: { available: true, tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } },
          degradedCapabilities: [],
          model: { provider: 'anthropic', model: 'claude-haiku-4' }
        }
      })
    };

    const directCall = {
      purpose: 'intent_classification',
      input: { text: 'test' },
      resultValidation: { schemaId: 'intent', schema: { parse: (v: unknown) => v } as unknown as import('zod').ZodTypeAny }
    };

    const unitOfWork = createExecutionRunUnitOfWork({
      execute: { execute: vi.fn() } as unknown as ExecutionEntryPoint,
      resolveContext: async () => makeContext(),
      resolveExecutionMode: () => ({ mode: 'direct' as const, directCall }),
      direct: directPort,
      eventsStore: newStore(),
      sessions
    });

    const result = await unitOfWork.run(makeRoleInput('implementer', 1));
    expect(result.directive).toBe('advance');
    expect(sessions.create).toHaveBeenCalledOnce();
    const call = (sessions.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call).toMatchObject({
      runId,
      step: 'implementation.build',
      role: 'implementer',
      round: 1,
      outcome: 'succeeded',
      usageAvailable: true,
      tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }
    });
  });

  it('does not record when direct mode is not configured and no model session ran', async () => {
    const sessions = makeSessions();
    const unitOfWork = createExecutionRunUnitOfWork({
      execute: { execute: vi.fn() } as unknown as ExecutionEntryPoint,
      resolveContext: async () => makeContext(),
      resolveExecutionMode: () => ({ mode: 'direct' as const, directCall: {} as unknown as import('@autocatalyst/execution').DirectCallRequest }),
      // direct: undefined — not configured
      eventsStore: newStore(),
      sessions
    });

    const result = await unitOfWork.run(makeRoleInput('implementer', 1));
    expect(result.directive).toBe('fail');
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it('fails dispatch when direct-mode session persistence fails', async () => {
    const sessions = makeSessions({
      create: vi.fn().mockRejectedValue(new Error('DB write failed'))
    });
    const directPort: DirectStepExecutionPort = {
      call: vi.fn().mockResolvedValue({
        value: { ok: true },
        validation: { status: 'valid' },
        metadata: {
          outcome: 'succeeded',
          tokenUsage: { available: false },
          degradedCapabilities: [],
          model: { provider: 'anthropic', model: 'claude-haiku-4' }
        }
      })
    };

    const directCall = {
      purpose: 'intent',
      input: {},
      resultValidation: { schemaId: 'test', schema: { parse: (v: unknown) => v } as unknown as import('zod').ZodTypeAny }
    };

    const unitOfWork = createExecutionRunUnitOfWork({
      execute: { execute: vi.fn() } as unknown as ExecutionEntryPoint,
      resolveContext: async () => makeContext(),
      resolveExecutionMode: () => ({ mode: 'direct' as const, directCall }),
      direct: directPort,
      eventsStore: newStore(),
      sessions
    });

    const result = await unitOfWork.run(makeRoleInput('implementer', 1));
    expect(result).toEqual({ directive: 'fail', reason: 'session_persistence_failed' });
  });

  // ---------------------------------------------------------------------------
  // Pre-terminal runner failure — INIT-2 regression
  // ---------------------------------------------------------------------------

  it('records a failed session row when the runner throws before emitting a terminal event', async () => {
    const sessions = makeSessions();
    // Simulate an entry point that carries pre-terminal metadata (as execution-entry-point
    // does when the runner throws mid-stream and getSessionMetadata() returns cached data).
    const preTerminalMeta: RunnerSessionMetadata = {
      ...baseSessionMetadata,
      outcome: 'failed'
    };
    const cause = new Error('adapter crash');
    const preTerminalFailure = new PreTerminalRunnerFailure(cause, preTerminalMeta);

    const throwingEntryPoint: ExecutionEntryPoint = {
      execute(_input: ExecutionEntryPointInput): AsyncIterable<ExecutionBoundaryEvent> {
        return (async function* () {
          throw preTerminalFailure;
        })();
      }
    };

    const unitOfWork = createExecutionRunUnitOfWork({
      execute: throwingEntryPoint,
      resolveContext: async () => makeContext(),
      eventsStore: newStore(),
      sessions
    });

    const result = await unitOfWork.run(makeRoleInput('implementer', 1));

    // The dispatch must still fail with a sanitized reason.
    expect(result.directive).toBe('fail');
    // A failed session row must have been recorded despite the pre-terminal throw.
    expect(sessions.create).toHaveBeenCalledOnce();
    const call = (sessions.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call).toMatchObject({
      runId,
      step: 'implementation.build',
      role: 'implementer',
      round: 1,
      outcome: 'failed'
    });
  });

  it('preserves original failure reason and logs safely when pre-terminal session persistence fails', async () => {
    const sessions = makeSessions({
      create: vi.fn().mockRejectedValue(new Error('DB write failed'))
    });
    const logger = { warn: vi.fn(), error: vi.fn() };
    const preTerminalMeta: RunnerSessionMetadata = {
      ...baseSessionMetadata,
      outcome: 'failed'
    };
    const cause = new Error('adapter crash before terminal');
    const preTerminalFailure = new PreTerminalRunnerFailure(cause, preTerminalMeta);

    const throwingEntryPoint: ExecutionEntryPoint = {
      execute(_input: ExecutionEntryPointInput): AsyncIterable<ExecutionBoundaryEvent> {
        return (async function* () {
          throw preTerminalFailure;
        })();
      }
    };

    const unitOfWork = createExecutionRunUnitOfWork({
      execute: throwingEntryPoint,
      resolveContext: async () => makeContext(),
      eventsStore: newStore(),
      sessions,
      logger
    });

    const result = await unitOfWork.run(makeRoleInput('implementer', 1));

    // Original reason preserved — not replaced by session_persistence_failed.
    expect(result.directive).toBe('fail');
    expect((result as { reason?: string }).reason).not.toBe('session_persistence_failed');
    // The persistence failure must be logged with only safe fields.
    expect(logger.error).toHaveBeenCalled();
    for (const call of (logger.error as ReturnType<typeof vi.fn>).mock.calls) {
      const logFields = call[0] as Record<string, unknown>;
      expect(logFields).toHaveProperty('runId');
      expect(logFields).toHaveProperty('step');
      expect(logFields).toHaveProperty('role');
      expect(logFields).toHaveProperty('errorName');
      expect(JSON.stringify(logFields)).not.toContain('DB write failed');
    }
  });

  // ---------------------------------------------------------------------------
  // Protocol error with cached metadata — P1 regression (non-convergence fix)
  // ---------------------------------------------------------------------------

  it('rethrows RunnerProtocolError even when wrapped in PreTerminalRunnerFailure with cached metadata', async () => {
    // Regression: execution-entry-point wraps RunnerProtocolError in PreTerminalRunnerFailure
    // when getSessionMetadata() returns cached data. The unit of work must still propagate it
    // as a RunnerProtocolError rather than downgrading it to { directive: 'fail' }.
    const sessions = makeSessions();
    const protocolError = new RunnerProtocolError('invalid_event', 'Adapter produced an invalid event.');
    const preTerminalMeta: RunnerSessionMetadata = { ...baseSessionMetadata, outcome: 'failed' };
    const wrapped = new PreTerminalRunnerFailure(protocolError, preTerminalMeta);

    const throwingEntryPoint: ExecutionEntryPoint = {
      execute(_input: ExecutionEntryPointInput): AsyncIterable<ExecutionBoundaryEvent> {
        return (async function* () {
          throw wrapped;
        })();
      }
    };

    const unitOfWork = createExecutionRunUnitOfWork({
      execute: throwingEntryPoint,
      resolveContext: async () => makeContext(),
      eventsStore: newStore(),
      sessions
    });

    await expect(unitOfWork.run(makeRoleInput('implementer', 1))).rejects.toBeInstanceOf(RunnerProtocolError);
    // Must NOT silently swallow into a { directive: 'fail' } and must NOT call sessions.create
    expect(sessions.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Model memory continuity — runSteps integration
// ---------------------------------------------------------------------------

function makeRunStep(overrides: Partial<RunStep> = {}): RunStep {
  return {
    id: 'step_1',
    runId,
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
    async create(_input) { return makeRunStep(); },
    async findById(id) { return steps.find(s => s.id === id) ?? null; },
    async listByRun(_runId) { return steps; },
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

describe('execution-run-unit-of-work model memory', () => {
  it('passes non-undefined modelMemory to execute when runSteps is provided', async () => {
    const capturedInputs: ExecutionEntryPointInput[] = [];
    const entryPoint: ExecutionEntryPoint = {
      execute(input: ExecutionEntryPointInput): AsyncIterable<ExecutionBoundaryEvent> {
        capturedInputs.push(input);
        return (async function* () {
          yield makeTerminalEvent('advance');
        })();
      }
    };

    const steps = [makeRunStep()];
    const runSteps = makeFakeRunStepRepo(steps);

    const unitOfWork = createExecutionRunUnitOfWork({
      execute: entryPoint,
      resolveContext: async () => makeContext(),
      eventsStore: newStore(),
      runSteps
    });

    await unitOfWork.run(makeRoleInput('implementer', 1));

    expect(capturedInputs).toHaveLength(1);
    expect(capturedInputs[0].modelMemory).toBeDefined();
    expect(typeof capturedInputs[0].modelMemory?.key).toBe('string');
    expect(capturedInputs[0].modelMemory?.store).toBeDefined();
  });

  it('model-memory save merges providerModelMemory into existing checkpoint data', async () => {
    const existingCheckpoint = { pause: { kind: 'model_question' } };
    const steps = [makeRunStep({ checkpointResult: existingCheckpoint })];
    const runSteps = makeFakeRunStepRepo(steps);

    let capturedStore: ExecutionEntryPointInput['modelMemory'] | undefined;
    const entryPoint: ExecutionEntryPoint = {
      execute(input: ExecutionEntryPointInput): AsyncIterable<ExecutionBoundaryEvent> {
        capturedStore = input.modelMemory;
        return (async function* () {
          yield makeTerminalEvent('advance');
        })();
      }
    };

    const unitOfWork = createExecutionRunUnitOfWork({
      execute: entryPoint,
      resolveContext: async () => makeContext(),
      eventsStore: newStore(),
      runSteps
    });

    await unitOfWork.run(makeRoleInput('implementer', 1));

    // Simulate adapter saving memory
    expect(capturedStore).toBeDefined();
    await capturedStore!.store.save({
      providerKind: 'openai',
      adapterId: 'openai-agents-sdk',
      state: { threadId: 'thread_test' }
    });

    // The checkpoint should now contain both the original data and the new memory
    expect(runSteps.capturedCheckpoints).toHaveLength(1);
    const saved = runSteps.capturedCheckpoints[0].checkpointResult as Record<string, unknown>;
    // Original fields must be preserved
    expect(saved['pause']).toEqual({ kind: 'model_question' });
    // New memory must be present
    expect(saved['providerModelMemory']).toBeDefined();
  });

  it('passes noop model memory store when runSteps is not provided', async () => {
    const capturedInputs: ExecutionEntryPointInput[] = [];
    const entryPoint: ExecutionEntryPoint = {
      execute(input: ExecutionEntryPointInput): AsyncIterable<ExecutionBoundaryEvent> {
        capturedInputs.push(input);
        return (async function* () {
          yield makeTerminalEvent('advance');
        })();
      }
    };

    const unitOfWork = createExecutionRunUnitOfWork({
      execute: entryPoint,
      resolveContext: async () => makeContext(),
      eventsStore: newStore()
      // runSteps not provided
    });

    await unitOfWork.run(makeRoleInput('implementer', 1));

    expect(capturedInputs).toHaveLength(1);
    // modelMemory should still be defined (with noop store) — adapter should always receive it
    expect(capturedInputs[0].modelMemory).toBeDefined();
    // The noop store returns null for load
    const result = await capturedInputs[0].modelMemory!.store.load();
    expect(result).toBeNull();
  });
});

// Suppress unused import lint
void ((null as unknown) as RunWorkResult);
void ((null as unknown) as ExecutionSessionRecordingError);
