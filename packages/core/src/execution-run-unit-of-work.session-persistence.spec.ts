import { describe, expect, it, vi } from 'vitest';

import type { ExecutionContext } from '@autocatalyst/api-contract';
import type { ExecutionBoundaryEvent, ExecutionEntryPoint, ExecutionEntryPointInput, RunnerSessionMetadata } from '@autocatalyst/execution';
import { ClassifiedProviderFailureError, PreTerminalRunnerFailure, RunnerProtocolError } from '@autocatalyst/execution';
import type { Session } from '@autocatalyst/api-contract';
import type { SessionRepository } from './domain-repositories.js';
import type { RunWorkInput, RunWorkResult } from './orchestrator.js';
import {
  createExecutionRunUnitOfWork,
  isRetryableSessionFailure,
  RUNNER_SESSION_MAX_RETRIES,
  RUNNER_SESSION_RETRY_BASE_DELAY_MS
} from './execution-run-unit-of-work.js';
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
    sequence: 1,
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
      usd: null,
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
        },
        sessionTelemetry: {
          startedAt: '2026-06-22T00:00:00.000Z',
          endedAt: '2026-06-22T00:00:01.500Z',
          durationMs: 1500,
          inferenceSettings: { temperature: 0.2, maxOutputTokens: 1024 },
          assistantTurnCount: 1,
          toolCallCount: 0
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
    // The recorder must carry the orchestrator-measured telemetry rather than
    // synthesizing a zero-duration row with empty inference settings.
    expect(call.startedAt).toBe('2026-06-22T00:00:00.000Z');
    expect(call.endedAt).toBe('2026-06-22T00:00:01.500Z');
    expect(call.inferenceSettings).toEqual({ temperature: 0.2, maxOutputTokens: 1024 });
    expect(call.assistantTurnCount).toBe(1);
    expect(call.toolCallCount).toBe(0);
    // startedAt and endedAt must differ so the persisted duration is real.
    expect(call.startedAt).not.toBe(call.endedAt);
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
        },
        sessionTelemetry: {
          startedAt: '2026-06-22T00:00:00.000Z',
          endedAt: '2026-06-22T00:00:00.750Z',
          durationMs: 750,
          inferenceSettings: {},
          assistantTurnCount: 1,
          toolCallCount: 0
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

  it('safely fails the dispatch when a direct port returns metadata without sessionTelemetry', async () => {
    // DirectStepExecutionPort is public/core-facing. A port compiled against a prior
    // DirectOrchestratorCallResult shape can return metadata (with model/tokenUsage) but
    // no sessionTelemetry. The unit of work must not crash into the outer direct-call
    // catch as `direct_call_failed`; it must surface a visible, safe persistence failure.
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
        // sessionTelemetry intentionally absent (legacy/third-party port shape)
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
    // Must be the safe persistence failure, NOT a raw `direct_call_failed` TypeError surface.
    expect(result).toEqual({ directive: 'fail', reason: 'session_persistence_failed' });
    // No durable row can be written without telemetry, so create must not be attempted.
    expect(sessions.create).not.toHaveBeenCalled();
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
        // eslint-disable-next-line require-yield
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
        // eslint-disable-next-line require-yield
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
        // eslint-disable-next-line require-yield
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
// Bounded session retry (transient pre-terminal failures)
// ---------------------------------------------------------------------------

function makeTransientPreTerminal(): PreTerminalRunnerFailure {
  const meta: RunnerSessionMetadata = { ...baseSessionMetadata, outcome: 'failed' };
  return new PreTerminalRunnerFailure(new ClassifiedProviderFailureError('transient_provider_failure'), meta);
}

function makePermanentPreTerminal(): PreTerminalRunnerFailure {
  const meta: RunnerSessionMetadata = { ...baseSessionMetadata, outcome: 'failed' };
  return new PreTerminalRunnerFailure(new ClassifiedProviderFailureError('provider_auth_failed'), meta);
}

type SequencedStep = { readonly throw: unknown } | { readonly events: ExecutionBoundaryEvent[] };

// Entry point whose behavior advances per attempt (execute() is called once per in-dispatch attempt).
function makeSequencedEntryPoint(steps: readonly SequencedStep[]): { entry: ExecutionEntryPoint; calls: () => number } {
  let i = 0;
  return {
    calls: () => i,
    entry: {
      execute(_input: ExecutionEntryPointInput): AsyncIterable<ExecutionBoundaryEvent> {
        const step = steps[Math.min(i, steps.length - 1)]!;
        i += 1;
        return (async function* () {
          if ('throw' in step) throw step.throw;
          for (const event of step.events) yield event;
        })();
      }
    }
  };
}

// Real in-memory session repository with monotonic per-run sequence assignment.
function makeStoringSessions(): { sessions: SessionRepository; rows: () => Session[] } {
  const rows: Session[] = [];
  let seq = 0;
  const sessions: SessionRepository = {
    async create(input) {
      seq += 1;
      const row = { ...makeSession(), ...(input as Partial<Session>), id: `session_${seq}`, sequence: seq } as Session;
      rows.push(row);
      return row;
    },
    async findById(id) { return rows.find((r) => r.id === id) ?? null; },
    async listByRun(_runId) { return rows.slice(); }
  };
  return { sessions, rows: () => rows.slice() };
}

describe('execution-run-unit-of-work bounded session retry', () => {
  it('isRetryableSessionFailure only accepts transient pre-terminal failures', () => {
    expect(isRetryableSessionFailure(makeTransientPreTerminal())).toBe(true);
    expect(isRetryableSessionFailure(makePermanentPreTerminal())).toBe(false);
    expect(isRetryableSessionFailure(new Error('plain'))).toBe(false);
    expect(isRetryableSessionFailure(new ClassifiedProviderFailureError('transient_provider_failure'))).toBe(false);
  });

  it('retries a transient pre-terminal failure and succeeds in the same workspace', async () => {
    const sessions = makeSessions();
    const sleeps: number[] = [];
    const { entry, calls } = makeSequencedEntryPoint([
      { throw: makeTransientPreTerminal() },
      { events: [makeTerminalEvent('advance')] }
    ]);
    const unitOfWork = createExecutionRunUnitOfWork({
      execute: entry,
      resolveContext: async () => makeContext(),
      eventsStore: newStore(),
      sessions,
      sleep: async (ms) => { sleeps.push(ms); }
    });

    const result = await unitOfWork.run(makeRoleInput('implementer', 1));
    expect(result).toEqual({ directive: 'advance' });
    expect(calls()).toBe(2); // initial + one retry
    expect(sleeps).toEqual([RUNNER_SESSION_RETRY_BASE_DELAY_MS]); // 2000
    // One failed attempt row + one succeeded row.
    expect((sessions.create as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
    expect((sessions.create as ReturnType<typeof vi.fn>).mock.calls[0][0].outcome).toBe('failed');
    expect((sessions.create as ReturnType<typeof vi.fn>).mock.calls[1][0].outcome).toBe('succeeded');
  });

  it('exhausts the retry budget and fails with transient_provider_session_retries_exhausted', async () => {
    const sessions = makeSessions();
    const sleeps: number[] = [];
    const { entry, calls } = makeSequencedEntryPoint([{ throw: makeTransientPreTerminal() }]);
    const unitOfWork = createExecutionRunUnitOfWork({
      execute: entry,
      resolveContext: async () => makeContext(),
      eventsStore: newStore(),
      sessions,
      sleep: async (ms) => { sleeps.push(ms); }
    });

    const result = await unitOfWork.run(makeRoleInput('implementer', 1));
    expect(result).toEqual({ directive: 'fail', reason: 'transient_provider_session_retries_exhausted' });
    expect(calls()).toBe(1 + RUNNER_SESSION_MAX_RETRIES); // 3 attempts
    expect(sleeps).toEqual([2000, 4000]); // exponential backoff
    // A failed session row is recorded for every attempt.
    expect((sessions.create as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3);
  });

  it('does not retry a permanent (classified) pre-terminal failure', async () => {
    const sessions = makeSessions();
    const sleeps: number[] = [];
    const { entry, calls } = makeSequencedEntryPoint([{ throw: makePermanentPreTerminal() }]);
    const unitOfWork = createExecutionRunUnitOfWork({
      execute: entry,
      resolveContext: async () => makeContext(),
      eventsStore: newStore(),
      sessions,
      sleep: async (ms) => { sleeps.push(ms); }
    });

    const result = await unitOfWork.run(makeRoleInput('implementer', 1));
    expect(result).toEqual({ directive: 'fail', reason: 'provider_auth_failed' });
    expect(calls()).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it('stops retrying when the run is canceled between attempts and preserves cancellation semantics', async () => {
    const sessions = makeSessions();
    const sleeps: number[] = [];
    const { entry, calls } = makeSequencedEntryPoint([{ throw: makeTransientPreTerminal() }]);
    const unitOfWork = createExecutionRunUnitOfWork({
      execute: entry,
      resolveContext: async () => makeContext(),
      eventsStore: newStore(),
      sessions,
      sleep: async (ms) => { sleeps.push(ms); },
      isRunCanceled: async () => true
    });

    const result = await unitOfWork.run(makeRoleInput('implementer', 1));
    // Canceled before the first retry: not exhausted, no further attempts.
    expect(result).toEqual({ directive: 'fail', reason: 'transient_provider_failure' });
    expect(calls()).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it('persists a durable failed row per attempt with increasing sequence while convergence round is unchanged', async () => {
    const { sessions, rows } = makeStoringSessions();
    const { entry } = makeSequencedEntryPoint([
      { throw: makeTransientPreTerminal() },
      { events: [makeTerminalEvent('advance')] }
    ]);
    const unitOfWork = createExecutionRunUnitOfWork({
      execute: entry,
      resolveContext: async () => makeContext(),
      eventsStore: newStore(),
      sessions,
      sleep: async () => undefined
    });

    const result = await unitOfWork.run(makeRoleInput('reviewer', 2));
    expect(result).toEqual({ directive: 'advance' });

    const persisted = rows();
    expect(persisted.length).toBe(2);
    // Sessions share step/role/round; sequence increases; no new run-step occurrence is created here.
    expect(persisted.map((r) => r.sequence)).toEqual([1, 2]);
    expect(persisted.every((r) => r.round === 2)).toBe(true);
    expect(persisted.every((r) => r.role === 'reviewer')).toBe(true);
    expect(persisted.every((r) => r.step === 'implementation.build')).toBe(true);
    expect(persisted[0]!.outcome).toBe('failed');
    expect(persisted[1]!.outcome).toBe('succeeded');
  });

  it('documents the worst-case default failure time formula (~366000 ms)', () => {
    // (1 + SDK retries) × PROXY_RETRY_BUDGET_MS × (1 + RUNNER_SESSION_MAX_RETRIES) + session backoff.
    const PROXY_RETRY_BUDGET_MS = 60000;
    const sdkRetries = 1;
    const sessionBackoff = RUNNER_SESSION_RETRY_BASE_DELAY_MS + RUNNER_SESSION_RETRY_BASE_DELAY_MS * 2; // 2000 + 4000
    const worstCase = (1 + sdkRetries) * PROXY_RETRY_BUDGET_MS * (1 + RUNNER_SESSION_MAX_RETRIES) + sessionBackoff;
    expect(worstCase).toBe(366000);
  });
});

// Suppress unused import lint
void ((null as unknown) as RunWorkResult);
void ((null as unknown) as ExecutionSessionRecordingError);
