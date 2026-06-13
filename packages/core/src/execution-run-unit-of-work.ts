import type { ExecutionContext, JsonValue } from '@autocatalyst/api-contract';
import {
  RunnerProtocolError,
  ExecutionMaterializationError,
  isClassifiedProviderFailureError,
  type ExecutionBoundaryEvent,
  type DirectCallRequest,
  type DirectOrchestratorCallResult
} from '@autocatalyst/execution';
import type { ExecutionEntryPoint } from '@autocatalyst/execution';
import type { RunWorkInput, RunWorkResult, RunUnitOfWork } from './orchestrator.js';
import { consumeRunnerEvents } from './runner-event-consumer.js';
import { InMemoryRetainedRunEventStore, type RunEventStore } from './run-events.js';

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
}

export type ExecutionRunUnitOfWorkResult = RunWorkResult & {
  readonly checkpointResult?: JsonValue;
};

export interface ExecutionRunUnitOfWork extends RunUnitOfWork {
  runWithCheckpoint(input: RunWorkInput): Promise<{ workResult: RunWorkResult; checkpointResult?: JsonValue }>;
}

export function createExecutionRunUnitOfWork(options: ExecutionRunUnitOfWorkOptions): ExecutionRunUnitOfWork {
  return {
    async run(input: RunWorkInput): Promise<RunWorkResult> {
      const inner = await this.runWithCheckpoint(input);
      return inner.workResult;
    },
    async runWithCheckpoint(input: RunWorkInput): Promise<{ workResult: RunWorkResult; checkpointResult?: JsonValue }> {
      const context = await options.resolveContext(input);

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

      // Agent path (existing behavior, unchanged)
      const events = options.execute.execute({ context, correlationId: input.runId });
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
      try {
        return await consumeRunnerEvents({
          eventsStore,
          events: tapped,
          runId: input.runId,
          tenant: input.tenant
        });
      } catch (error) {
        if (error instanceof RunnerProtocolError) {
          throw error;
        }
        if (isClassifiedProviderFailureError(error)) {
          return { workResult: { directive: 'fail', reason: error.failureReason } };
        }
        let reason: string;
        if (error instanceof ExecutionMaterializationError) {
          reason = `Execution failed: ${error.code}`;
        } else {
          reason = 'Runner failed before terminal result.';
        }
        return { workResult: { directive: 'fail', reason } };
      }
    }
  };
}
