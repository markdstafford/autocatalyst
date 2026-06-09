import type { ExecutionContext, RunnerEvent } from '@autocatalyst/api-contract';
import type { MaterializedExecutionEnvironment } from './materialized-environment.js';
import { RunnerProtocolError } from './runner.js';
import type { Runner } from './runner.js';

export interface ExecutionEntryPointInput {
  readonly context: ExecutionContext;
  readonly correlationId?: string;
}

export interface ExecutionEntryPoint {
  execute(input: ExecutionEntryPointInput): AsyncIterable<RunnerEvent>;
}

export interface CreateExecutionEntryPointOptions {
  readonly runner: Runner;
  readonly materialize: (context: ExecutionContext) => Promise<MaterializedExecutionEnvironment>;
}

export function createExecutionEntryPoint(options: CreateExecutionEntryPointOptions): ExecutionEntryPoint {
  return {
    async *execute(input: ExecutionEntryPointInput): AsyncIterable<RunnerEvent> {
      const environment = await options.materialize(input.context);
      const runnerInput = {
        environment,
        ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {})
      };
      let streamError: unknown = undefined;
      let closeProtocolError: RunnerProtocolError | undefined;
      let terminalSeen = false;
      try {
        for await (const event of options.runner.run(runnerInput)) {
          if (event.type === 'runner_terminal_result') {
            terminalSeen = true;
          }
          yield event;
        }
      } catch (error) {
        streamError = error;
      } finally {
        try {
          await options.runner.close();
        } catch {
          if (streamError === undefined) {
            // Stream succeeded but close failed → runner_close_failed takes precedence
            closeProtocolError = new RunnerProtocolError(
              'runner_close_failed',
              'Runner close failed after successful stream completion.'
            );
          } else if (!terminalSeen) {
            // Stream threw before any terminal result AND close also failed → teardown
            // integrity is unknown; close failure takes precedence over the stream error.
            closeProtocolError = new RunnerProtocolError(
              'runner_close_failed',
              'Runner close failed after pre-terminal stream error; teardown integrity unknown.'
            );
          }
          // Post-terminal stream error + close failure: original stream error takes precedence
          // (terminalSeen === true && streamError !== undefined).
        }
      }
      if (closeProtocolError !== undefined) {
        throw closeProtocolError;
      }
      if (streamError !== undefined) {
        throw streamError;
      }
    }
  };
}
