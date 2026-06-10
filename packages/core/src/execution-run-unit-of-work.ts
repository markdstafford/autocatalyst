import type { ExecutionContext, JsonValue } from '@autocatalyst/api-contract';
import {
  RunnerProtocolError,
  ExecutionMaterializationError,
  type ExecutionBoundaryEvent
} from '@autocatalyst/execution';
import type { ExecutionEntryPoint } from '@autocatalyst/execution';
import type { RunWorkInput, RunWorkResult, RunUnitOfWork } from './orchestrator.js';
import { consumeRunnerEvents } from './runner-event-consumer.js';
import { InMemoryRetainedRunEventStore, type RunEventStore } from './run-events.js';

export interface ExecutionRunUnitOfWorkOptions {
  readonly execute: ExecutionEntryPoint;
  readonly resolveContext: (input: RunWorkInput) => Promise<ExecutionContext>;
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
    async runWithCheckpoint(input: RunWorkInput) {
      const context = await options.resolveContext(input);
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
