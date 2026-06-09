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
          if (streamError === undefined && terminalSeen) {
            // Stream completed cleanly with terminal, but close failed
            closeProtocolError = new RunnerProtocolError(
              'runner_close_failed',
              'Runner close failed after successful stream completion.'
            );
          }
          // When no terminal was seen (whether stream threw or completed normally):
          // - If stream threw: streamError propagates below
          // - If stream completed without terminal: generator returns normally,
          //   consumer will catch missing_terminal_result
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
