import type {
  InferenceSettings,
  ModelIdentity,
  Session,
  SessionOutcome,
  SessionRole,
  TokenBreakdown
} from '@autocatalyst/api-contract';
import { createSessionInputSchema } from '@autocatalyst/api-contract';
import type { SessionRepository } from './domain-repositories.js';

const zeroTokens: TokenBreakdown = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export class ExecutionSessionRecordingError extends Error {
  readonly code: 'invalid_session_context' | 'session_persistence_failed';
  override readonly cause?: unknown;

  constructor(code: 'invalid_session_context' | 'session_persistence_failed', message: string, cause?: unknown) {
    super(message);
    this.name = 'ExecutionSessionRecordingError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

export interface ExecutionSessionRecorderLogger {
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export interface ExecutionSessionRecorderDependencies {
  readonly sessions: SessionRepository;
  readonly logger?: ExecutionSessionRecorderLogger;
}

export interface RecordExecutionSessionInput {
  readonly runId: string;
  readonly phase: string | null;
  readonly step: string;
  readonly role: SessionRole;
  readonly round: number;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly outcome: SessionOutcome | 'needs_input';
  readonly model: ModelIdentity;
  readonly inferenceSettings: InferenceSettings;
  readonly tokens?: TokenBreakdown;
  readonly usageAvailable?: boolean;
  readonly assistantTurnCount?: number;
  readonly toolCallCount?: number;
}

function durationMs(startedAt: string, endedAt: string | null): number | null {
  if (endedAt === null) return null;
  const started = Date.parse(startedAt);
  const ended = Date.parse(endedAt);
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) return null;
  return ended - started;
}

function resolveUsage(input: RecordExecutionSessionInput): { usageAvailable: boolean; tokens: TokenBreakdown } {
  if (input.usageAvailable === false) return { usageAvailable: false, tokens: zeroTokens };
  if (input.tokens === undefined) return { usageAvailable: false, tokens: zeroTokens };
  return { usageAvailable: true, tokens: input.tokens };
}

export async function recordExecutionSession(
  dependencies: ExecutionSessionRecorderDependencies,
  input: RecordExecutionSessionInput
): Promise<Session> {
  const usage = resolveUsage(input);
  // Map needs_input to succeeded (it's a successful session that awaits human input)
  const persistedOutcome: string = input.outcome === 'needs_input' ? 'succeeded' : input.outcome;

  let createInput;
  try {
    createInput = createSessionInputSchema.parse({
      runId: input.runId,
      phase: input.phase,
      step: input.step,
      role: input.role,
      round: input.round,
      model: input.model,
      inferenceSettings: input.inferenceSettings,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      durationMs: durationMs(input.startedAt, input.endedAt),
      tokens: usage.tokens,
      usageAvailable: usage.usageAvailable,
      assistantTurnCount: input.assistantTurnCount ?? 0,
      toolCallCount: input.toolCallCount ?? 0,
      outcome: persistedOutcome,
      cost: { model: input.model, usd: 0, tokens: usage.tokens }
    });
  } catch {
    throw new ExecutionSessionRecordingError(
      'invalid_session_context',
      'Invalid execution session context: session data failed schema validation.'
    );
  }

  try {
    return await dependencies.sessions.create(createInput);
  } catch (error) {
    dependencies.logger?.error(
      { runId: input.runId, step: input.step, role: input.role, errorName: error instanceof Error ? error.name : 'UnknownError' },
      'Failed to persist execution session.'
    );
    throw new ExecutionSessionRecordingError('session_persistence_failed', 'Failed to persist execution session.', error);
  }
}
