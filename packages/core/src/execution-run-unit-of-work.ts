import type { ExecutionContext, JsonValue } from '@autocatalyst/api-contract';
import {
  RunnerProtocolError,
  PreTerminalRunnerFailure,
  type ExecutionBoundaryEvent,
  type DirectCallRequest,
  type DirectOrchestratorCallResult,
  createNoopAgentModelMemoryStore
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
import type { RunStepRepository, SessionRepository } from './domain-repositories.js';
import { deriveAgentModelMemoryKey, createRunStepAgentModelMemoryStore } from './provider-model-memory.js';

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
  /** Optional run step repository for persisting provider model memory continuity. */
  readonly runSteps?: RunStepRepository;
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
            const nowIso = new Date().toISOString();
            try {
              await recordExecutionSession(
                { sessions: options.sessions, ...(options.logger !== undefined ? { logger: options.logger } : {}) },
                {
                  runId: input.runId,
                  phase: derivePhase(input),
                  step: input.run.currentStep,
                  role: deriveRole(input) as 'implementer' | 'reviewer',
                  round: deriveRound(input),
                  startedAt: nowIso,
                  endedAt: nowIso,
                  outcome: 'succeeded',
                  model: meta.model!,
                  inferenceSettings: {},
                  ...(meta.tokenUsage.available === true && meta.tokenUsage.tokens !== undefined
                    ? { tokens: meta.tokenUsage.tokens, usageAvailable: true }
                    : { usageAvailable: false })
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

      // Agent path
      // Build model memory continuity for this agent dispatch
      const role = deriveRole(input);
      const mmKey = deriveAgentModelMemoryKey({
        runId: input.runId,
        step: input.run.currentStep,
        role,
        providerKind: 'unknown',
        adapterId: 'unknown',
        profileName: 'unknown'
      });
      const modelMemory = {
        key: mmKey,
        store: options.runSteps !== undefined
          ? createRunStepAgentModelMemoryStore({
              runSteps: options.runSteps,
              runId: input.runId,
              tenant: input.tenant,
              currentStep: input.run.currentStep,
              key: mmKey
            })
          : createNoopAgentModelMemoryStore()
      };

      const events = options.execute.execute({ context, correlationId: input.runId, modelMemory });
      const onEvent = options.onEvent;
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
      const eventsStore = options.eventsStore ?? new InMemoryRetainedRunEventStore();
      let consumeResult: Awaited<ReturnType<typeof consumeRunnerEvents>>;
      try {
        consumeResult = await consumeRunnerEvents({
          eventsStore,
          events: tapped,
          runId: input.runId,
          tenant: input.tenant
        });
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
        // For pre-terminal runner failures, try to record a failed session row from the cached
        // metadata before returning. Persistence failures here are logged but must not replace
        // the original sanitized terminal reason.
        const preTerminalMeta = error instanceof PreTerminalRunnerFailure ? error.sessionMetadata : undefined;
        const actualError = error instanceof PreTerminalRunnerFailure ? error.cause : error;
        const reason = safeFailureReasonFromError(actualError) ?? 'Runner failed before terminal result.';

        if (options.sessions !== undefined && preTerminalMeta !== undefined) {
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

        return { workResult: { directive: 'fail', reason } };
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
