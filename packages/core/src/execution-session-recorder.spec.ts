import { describe, expect, it, vi } from 'vitest';

import type { Session } from '@autocatalyst/api-contract';
import type { SessionRepository } from './domain-repositories.js';
import { recordExecutionSession, ExecutionSessionRecordingError } from './execution-session-recorder.js';

const model = { provider: 'anthropic', model: 'claude-sonnet-4' } as const;

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session_1',
    runId: 'run_1',
    phase: 'implementation',
    step: 'implementation.build',
    role: 'implementer',
    round: 1,
    model,
    inferenceSettings: {},
    startedAt: '2026-06-22T00:03:00.000Z',
    endedAt: '2026-06-22T00:04:00.000Z',
    durationMs: 60000,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    usageAvailable: false,
    assistantTurnCount: 0,
    toolCallCount: 0,
    outcome: 'succeeded',
    cost: { model, usd: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
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

const baseInput = {
  runId: 'run_1',
  phase: 'implementation' as string | null,
  step: 'implementation.build',
  role: 'implementer',
  round: 1,
  model,
  inferenceSettings: {},
  startedAt: '2026-06-22T00:03:00.000Z',
  endedAt: '2026-06-22T00:04:00.000Z',
  outcome: 'succeeded' as const
} as const;

describe('recordExecutionSession', () => {
  it('persists succeeded sessions with supplied usage', async () => {
    const sessions = makeSessions();
    await recordExecutionSession({ sessions }, {
      ...baseInput,
      tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
      usageAvailable: true
    });

    const call = (sessions.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call).toMatchObject({
      runId: 'run_1',
      phase: 'implementation',
      step: 'implementation.build',
      role: 'implementer',
      round: 1,
      model,
      inferenceSettings: {},
      startedAt: '2026-06-22T00:03:00.000Z',
      endedAt: '2026-06-22T00:04:00.000Z',
      durationMs: 60000,
      usageAvailable: true,
      tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
      assistantTurnCount: 0,
      toolCallCount: 0,
      outcome: 'succeeded',
      cost: { model, usd: 0, tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } }
    });
    expect(call.tokens.input).toBe(10);
    expect(call.cost.tokens.input).toBe(10);
  });

  it('persists needs_input sessions as succeeded', async () => {
    const sessions = makeSessions();
    await recordExecutionSession({ sessions }, {
      ...baseInput,
      outcome: 'needs_input' as unknown as 'succeeded'
    });

    const call = (sessions.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.outcome).toBe('succeeded');
  });

  it('persists failed, cancelled, and timeout outcomes', async () => {
    for (const outcome of ['failed', 'cancelled', 'timeout'] as const) {
      const sessions = makeSessions();
      await recordExecutionSession({ sessions }, { ...baseInput, outcome });
      const call = (sessions.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.outcome).toBe(outcome);
    }
  });

  it('defaults missing optional metadata to unavailable zero usage', async () => {
    const sessions = makeSessions();
    await recordExecutionSession({ sessions }, baseInput);

    const call = (sessions.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call).toEqual({
      runId: 'run_1',
      phase: 'implementation',
      step: 'implementation.build',
      role: 'implementer',
      round: 1,
      model,
      inferenceSettings: {},
      startedAt: '2026-06-22T00:03:00.000Z',
      endedAt: '2026-06-22T00:04:00.000Z',
      durationMs: 60000,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      usageAvailable: false,
      assistantTurnCount: 0,
      toolCallCount: 0,
      outcome: 'succeeded',
      cost: { model, usd: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
    });
  });

  it('lets explicit usageAvailable false zero token data', async () => {
    const sessions = makeSessions();
    await recordExecutionSession({ sessions }, {
      ...baseInput,
      usageAvailable: false,
      tokens: { input: 100, output: 50, cacheRead: 20, cacheWrite: 10 }
    });

    const call = (sessions.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.usageAvailable).toBe(false);
    expect(call.tokens).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(call.cost.tokens).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it('derives cost tokens from resolved session tokens', async () => {
    const sessions = makeSessions();
    await recordExecutionSession({ sessions }, {
      ...baseInput,
      tokens: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1 },
      usageAvailable: true
    });

    const call = (sessions.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.cost.tokens).toEqual({ input: 10, output: 5, cacheRead: 2, cacheWrite: 1 });
  });

  it('does not persist raw provider diagnostics from validation errors', async () => {
    const sessions = makeSessions();
    // Pass missing required fields to trigger validation error
    await expect(
      recordExecutionSession({ sessions }, {
        ...baseInput,
        runId: '' // violates min(1) constraint
      })
    ).rejects.toThrow(ExecutionSessionRecordingError);

    await expect(
      recordExecutionSession({ sessions }, {
        ...baseInput,
        runId: '' // violates min(1) constraint
      })
    ).rejects.toSatisfy((err: unknown) => {
      if (err instanceof ExecutionSessionRecordingError) {
        expect(err.message).not.toMatch(/ZodError/);
        expect(err.message).not.toMatch(/\/path\//);
        return true;
      }
      return false;
    });
  });

  it('surfaces repository create failures', async () => {
    const sessions = makeSessions({
      create: vi.fn().mockRejectedValue(new Error('DB connection failed'))
    });

    await expect(
      recordExecutionSession({ sessions }, baseInput)
    ).rejects.toThrow(ExecutionSessionRecordingError);

    await expect(
      recordExecutionSession({ sessions }, baseInput)
    ).rejects.toSatisfy((err: unknown) => {
      if (err instanceof ExecutionSessionRecordingError) {
        expect(err.code).toBe('session_persistence_failed');
        return true;
      }
      return false;
    });
  });
});
