import type { ExecutionContext, JsonValue } from '@autocatalyst/api-contract';
import {
  RunnerProtocolError,
  PreTerminalRunnerFailure,
  type ExecutionBoundaryEvent,
  type DirectCallRequest,
  type DirectOrchestratorCallResult,
  type RunnerSessionMetadata
} from '@autocatalyst/execution';
import type { ExecutionEntryPoint } from '@autocatalyst/execution';
import type { RunWorkInput, RunWorkResult, RunUnitOfWork } from './orchestrator.js';
import type { RunRoleWorkInput } from './reviewed-role-dispatcher.js';
import { consumeRunnerEvents } from './runner-event-consumer.js';
import { InMemoryRetainedRunEventStore, type RunEventStore } from './run-events.js';
import { safeFailureReasonFromError } from './safe-failure-reason.js';
import {
  recordExecutionSession,
  ExecutionSessionRecordingError,
  type ExecutionSessionRecorderLogger
} from './execution-session-recorder.js';
import type { SessionRepository } from './domain-repositories.js';

export interface DirectStepWorkInput {
  readonly runId: string;
  readonly tenant: string;
  readonly phase?: string;
  readonly step: string;
  readonly directCall: DirectCallRequest;
}

export interface DirectStepExecutionPort {
  call(input: DirectStepWorkInput): Promise<DirectOrchestratorCallResult>;
}

export type ExecutionModeResolution =
  | { readonly mode: 'agent' }
  | { readonly mode: 'direct'; readonly directCall: DirectCallRequest };

export interface SessionRetryPolicyOptions {
  /** Max session retries after the initial attempt. Default RUNNER_SESSION_MAX_RETRIES (2). */
  readonly maxRetries?: number;
  /** Base backoff before the first retry, doubled per retry. Default RUNNER_SESSION_RETRY_BASE_DELAY_MS (2000). */
  readonly baseDelayMs?: number;
}

export interface ExecutionRunUnitOfWorkOptions {
  readonly execute: ExecutionEntryPoint;
  readonly resolveContext: (input: RunWorkInput) => Promise<ExecutionContext>;
  readonly resolveExecutionMode?: (
    input: RunWorkInput,
    context: ExecutionContext
  ) => Promise<ExecutionModeResolution> | ExecutionModeResolution;
  readonly direct?: DirectStepExecutionPort;
  readonly eventsStore?: RunEventStore;
  /** Optional passthrough observer for each validated boundary event (used by integration tests). */
  readonly onEvent?: (event: ExecutionBoundaryEvent) => void | Promise<void>;
  /** Optional session repository for durable session recording. */
  readonly sessions?: SessionRepository;
  /** Optional logger for session recording errors (only logs runId, step, role, error name/code). */
  readonly logger?: ExecutionSessionRecorderLogger;
  /** Optional bounded session-retry policy for transient pre-terminal session failures. */
  readonly sessionRetry?: SessionRetryPolicyOptions;
  /** Injected sleep for retry backoff (tests pass a no-op; defaults to a real timer). */
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * Optional check consulted before each session retry. When it resolves true, retrying stops and
   * cancellation semantics are preserved. When absent, no cancellation check is performed.
   */
  readonly isRunCanceled?: (runId: string) => boolean | Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Session retry policy
// ---------------------------------------------------------------------------

/**
 * Default session-retry limit: one initial session plus up to this many retries. Worst-case default
 * time before a fully-down Grove network fails a run is about 366000 ms —
 * `(1 + SDK retries) × PROXY_RETRY_BUDGET_MS × (1 + RUNNER_SESSION_MAX_RETRIES)` plus
 * `2000 + 4000` ms of session backoff, i.e. `(1 + 1) × 60000 × (1 + 2) + 6000 = 366000`.
 */
export const RUNNER_SESSION_MAX_RETRIES = 2;
/** Base session-retry backoff, doubled per retry (2000 → 4000 …). */
export const RUNNER_SESSION_RETRY_BASE_DELAY_MS = 2000;

const defaultRetrySleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Decide whether a caught dispatch error is a retryable pre-terminal transient session failure.
 * Only a {@link PreTerminalRunnerFailure} whose underlying cause classifies as
 * `transient_provider_failure` qualifies — this covers both an explicitly-classified transient
 * failure and an unclassified failure the Claude adapter promoted on qualifying unrecovered proxy
 * evidence. Permanent failures (auth, protocol, validation/contract, unsupported capability,
 * workspace/materialization) and plain errors are never retryable.
 */
export function isRetryableSessionFailure(error: unknown): boolean {
  if (!(error instanceof PreTerminalRunnerFailure)) return false;
  return safeFailureReasonFromError(error.cause) === 'transient_provider_failure';
}

export type ExecutionRunUnitOfWorkResult = RunWorkResult & {
  readonly checkpointResult?: JsonValue;
};

export interface ExecutionRunUnitOfWork extends RunUnitOfWork {
  runWithCheckpoint(input: RunWorkInput): Promise<{ workResult: RunWorkResult; checkpointResult?: JsonValue }>;
}

// ---------------------------------------------------------------------------
// Dispatch context helpers
// ---------------------------------------------------------------------------

function deriveRole(input: RunWorkInput): string {
  const roleInput = input as RunRoleWorkInput;
  return typeof roleInput.role === 'string' && roleInput.role.length > 0 ? roleInput.role : 'implementer';
}

function deriveRound(input: RunWorkInput): number {
  const roleInput = input as RunRoleWorkInput;
  return typeof roleInput.round === 'number' && roleInput.round > 0 ? roleInput.round : 1;
}

function derivePhase(input: RunWorkInput): string | null {
  // Use the step's phase prefix (first segment before the dot), or null if not present.
  const step = input.run.currentStep;
  const dotIndex = step.indexOf('.');
  return dotIndex > 0 ? step.slice(0, dotIndex) : null;
}

type SessionOutcomeKind = 'succeeded' | 'failed' | 'cancelled' | 'timeout' | 'needs_input';

function deriveAgentOutcome(workResult: RunWorkResult): SessionOutcomeKind {
  switch (workResult.directive) {
    case 'advance': return 'succeeded';
    case 'needs_input': return 'needs_input';
    case 'fail': return 'failed';
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createExecutionRunUnitOfWork(options: ExecutionRunUnitOfWorkOptions): ExecutionRunUnitOfWork {
  return {
    async run(input: RunWorkInput): Promise<RunWorkResult> {
      const inner = await this.runWithCheckpoint(input);
      return inner.workResult;
    },
    async runWithCheckpoint(input: RunWorkInput): Promise<{ workResult: RunWorkResult; checkpointResult?: JsonValue }> {
      let context: ExecutionContext;
      try {
        context = await options.resolveContext(input);
      } catch (error) {
        const reason = safeFailureReasonFromError(error);
        if (reason !== undefined) {
          return { workResult: { directive: 'fail' as const, reason } };
        }
        throw error;
      }

      // Resolve execution mode (default to agent for backward compat)
      const modeResolution = options.resolveExecutionMode !== undefined
        ? await options.resolveExecutionMode(input, context)
        : { mode: 'agent' as const };

      if (modeResolution.mode === 'direct') {
        if (options.direct === undefined) {
          return { workResult: { directive: 'fail' as const, reason: 'Execution failed: direct_port_not_configured' } };
        }
        try {
          const directResult = await options.direct.call({
            runId: input.runId,
            tenant: input.tenant,
            step: input.run.currentStep,
            directCall: modeResolution.directCall
          });

          // Record session for direct mode when sessions repo and model are available.
          if (options.sessions !== undefined && directResult.metadata.model !== undefined) {
            const meta = directResult.metadata;
            // Carry the orchestrator-measured telemetry (real start/end timestamps, the
            // resolved profile inference settings, and the applicable per-call counts)
            // instead of a synthesized zero-duration row with empty settings.
            //
            // `DirectStepExecutionPort` is public/core-facing. A direct port compiled
            // against a prior `DirectOrchestratorCallResult` shape can return metadata
            // without `sessionTelemetry`. Dereferencing it unconditionally would throw a
            // raw TypeError that the outer direct-call catch surfaces as
            // `direct_call_failed`, skipping the intended safe session-persistence
            // handling. Treat missing telemetry as a visible, safe persistence failure
            // (the same outcome as a recorder error on direct advance) rather than a
            // contract crash: a completed session we cannot durably record must fail the
            // dispatch, not disappear silently.
            const telemetry = directResult.sessionTelemetry;
            if (telemetry === undefined) {
              return { workResult: { directive: 'fail' as const, reason: 'session_persistence_failed' } };
            }
            try {
              await recordExecutionSession(
                { sessions: options.sessions, ...(options.logger !== undefined ? { logger: options.logger } : {}) },
                {
                  runId: input.runId,
                  phase: derivePhase(input),
                  step: input.run.currentStep,
                  role: deriveRole(input) as 'implementer' | 'reviewer',
                  round: deriveRound(input),
                  startedAt: telemetry.startedAt,
                  endedAt: telemetry.endedAt,
                  outcome: 'succeeded',
                  model: meta.model!,
                  inferenceSettings: telemetry.inferenceSettings,
                  ...(meta.tokenUsage.available === true && meta.tokenUsage.tokens !== undefined
                    ? { tokens: meta.tokenUsage.tokens, usageAvailable: true }
                    : { usageAvailable: false }),
                  assistantTurnCount: telemetry.assistantTurnCount,
                  toolCallCount: telemetry.toolCallCount
                }
              );
            } catch (recordError) {
              if (recordError instanceof ExecutionSessionRecordingError) {
                // For direct-mode advance, session persistence failure fails the dispatch.
                return { workResult: { directive: 'fail' as const, reason: 'session_persistence_failed' } };
              }
            }
          }

          return {
            workResult: { directive: 'advance' as const, result: directResult.value as unknown as Readonly<Record<string, unknown>> },
            checkpointResult: directResult.value as JsonValue
          };
        } catch (error) {
          let reason: string;
          const e = error as { code?: string; name?: string };
          if (e.code !== undefined) {
            reason = `Execution failed: ${e.code}`;
          } else {
            reason = 'Execution failed: direct_call_failed';
          }
          return { workResult: { directive: 'fail' as const, reason } };
        }
      }

      // Agent continuity is bound to materialized scratch by the agent orchestrator.
      const onEvent = options.onEvent;
      const eventsStore = options.eventsStore ?? new InMemoryRetainedRunEventStore();

      // Session-retry configuration. Each in-dispatch attempt re-runs the model session in the SAME
      // workspace (the execution context is unchanged) and records a durable failed session row;
      // no new run-step occurrence is created, so convergence-round accounting is untouched.
      const maxSessionRetries = options.sessionRetry?.maxRetries ?? RUNNER_SESSION_MAX_RETRIES;
      const sessionRetryBaseDelayMs = options.sessionRetry?.baseDelayMs ?? RUNNER_SESSION_RETRY_BASE_DELAY_MS;
      const sleep = options.sleep ?? defaultRetrySleep;

      // Record a durable failed session row from the cached pre-terminal metadata. Persistence
      // failures here are logged but must never replace the original sanitized terminal reason.
      async function recordPreTerminalFailedSession(
        preTerminalMeta: RunnerSessionMetadata
      ): Promise<void> {
        if (options.sessions === undefined) return;
        try {
          await recordExecutionSession(
            { sessions: options.sessions, ...(options.logger !== undefined ? { logger: options.logger } : {}) },
            {
              runId: input.runId,
              phase: derivePhase(input),
              step: input.run.currentStep,
              role: deriveRole(input) as 'implementer' | 'reviewer',
              round: deriveRound(input),
              startedAt: preTerminalMeta.startedAt,
              endedAt: preTerminalMeta.endedAt,
              outcome: 'failed',
              model: preTerminalMeta.model,
              inferenceSettings: preTerminalMeta.inferenceSettings,
              ...(preTerminalMeta.usageAvailable === true && preTerminalMeta.tokens !== undefined
                ? { tokens: preTerminalMeta.tokens, usageAvailable: true }
                : { usageAvailable: false }),
              ...(preTerminalMeta.assistantTurnCount !== undefined ? { assistantTurnCount: preTerminalMeta.assistantTurnCount } : {}),
              ...(preTerminalMeta.toolCallCount !== undefined ? { toolCallCount: preTerminalMeta.toolCallCount } : {})
            }
          );
        } catch (recordError) {
          options.logger?.error(
            {
              runId: input.runId,
              step: input.run.currentStep,
              role: deriveRole(input),
              errorName: recordError instanceof Error ? recordError.name : 'UnknownError',
              ...(recordError instanceof ExecutionSessionRecordingError && recordError.code !== undefined
                ? { errorCode: recordError.code }
                : {})
            },
            'Failed to record session for pre-terminal runner failure; original failure reason preserved.'
          );
        }
      }

      let consumeResult: Awaited<ReturnType<typeof consumeRunnerEvents>>;
      let retriesUsed = 0;
      // Bounded session-retry loop. Breaks out on a terminal result (advance/needs_input/fail) and
      // returns a fail directive when a transient session failure cannot be recovered.
      for (;;) {
        const events = options.execute.execute({ context, correlationId: input.runId });
        const tapped = onEvent === undefined
          ? events
          : (async function* () {
              for await (const event of events) {
                try {
                  await onEvent(event);
                } catch {
                  throw new RunnerProtocolError('runner_failed', 'Telemetry onEvent hook threw during event processing.');
                }
                yield event;
              }
            })();
        try {
          consumeResult = await consumeRunnerEvents({
            eventsStore,
            events: tapped,
            runId: input.runId,
            tenant: input.tenant
          });
          break;
        } catch (error) {
          if (error instanceof RunnerProtocolError) {
            throw error;
          }
          // A RunnerProtocolError wrapped in PreTerminalRunnerFailure (because the runner cached
          // metadata before the protocol violation) must still propagate as a protocol error,
          // not be downgraded to an ordinary run failure.
          if (error instanceof PreTerminalRunnerFailure && error.cause instanceof RunnerProtocolError) {
            throw error.cause;
          }
          // For pre-terminal runner failures, record a failed session row from the cached metadata.
          const preTerminalMeta = error instanceof PreTerminalRunnerFailure ? error.sessionMetadata : undefined;
          const actualError = error instanceof PreTerminalRunnerFailure ? error.cause : error;
          const reason = safeFailureReasonFromError(actualError) ?? 'Runner failed before terminal result.';

          if (preTerminalMeta !== undefined) {
            await recordPreTerminalFailedSession(preTerminalMeta);
          }

          if (isRetryableSessionFailure(error)) {
            if (retriesUsed >= maxSessionRetries) {
              // Budget exhausted: fail through the normal run-failure flow with a safe reason so
              // POST /v1/runs/:id/recover remains available.
              return { workResult: { directive: 'fail', reason: 'transient_provider_session_retries_exhausted' } };
            }
            // Honor cancellation/transition before spending another attempt.
            const canceled = options.isRunCanceled !== undefined
              ? await options.isRunCanceled(input.runId)
              : false;
            if (canceled) {
              return { workResult: { directive: 'fail', reason } };
            }
            const delayMs = sessionRetryBaseDelayMs * Math.pow(2, retriesUsed);
            retriesUsed += 1;
            await sleep(delayMs);
            continue;
          }

          return { workResult: { directive: 'fail', reason } };
        }
      }

      // Record durable session when session metadata and sessions repo are available.
      if (options.sessions !== undefined && consumeResult.sessionMetadata !== undefined) {
        const meta = consumeResult.sessionMetadata;
        const outcome = deriveAgentOutcome(consumeResult.workResult);
        try {
          await recordExecutionSession(
            { sessions: options.sessions, ...(options.logger !== undefined ? { logger: options.logger } : {}) },
            {
              runId: input.runId,
              phase: derivePhase(input),
              step: input.run.currentStep,
              role: deriveRole(input) as 'implementer' | 'reviewer',
              round: deriveRound(input),
              startedAt: meta.startedAt,
              endedAt: meta.endedAt,
              outcome,
              model: meta.model,
              inferenceSettings: meta.inferenceSettings,
              ...(meta.usageAvailable === true && meta.tokens !== undefined
                ? { tokens: meta.tokens, usageAvailable: true }
                : { usageAvailable: false }),
              ...(meta.assistantTurnCount !== undefined ? { assistantTurnCount: meta.assistantTurnCount } : {}),
              ...(meta.toolCallCount !== undefined ? { toolCallCount: meta.toolCallCount } : {})
            }
          );
        } catch (recordError) {
          if (recordError instanceof ExecutionSessionRecordingError) {
            // For advance and needs_input results: session persistence failure fails the dispatch.
            // For fail results: log safely and preserve the original reason.
            if (consumeResult.workResult.directive === 'advance' || consumeResult.workResult.directive === 'needs_input') {
              return { workResult: { directive: 'fail' as const, reason: 'session_persistence_failed' } };
            }
            // fail result: log and keep original
            options.logger?.error(
              {
                runId: input.runId,
                step: input.run.currentStep,
                role: deriveRole(input),
                errorName: recordError.name,
                ...(recordError.code !== undefined ? { errorCode: recordError.code } : {})
              },
              'Failed to record session for failed dispatch; original failure reason preserved.'
            );
          }
          // For non-recording errors (unexpected), we just log and keep original result
        }
      }

      return consumeResult;
    }
  };
}
