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
      try {
        for await (const event of options.runner.run(runnerInput)) {
          yield event;
        }
      } catch (error) {
        streamError = error;
        throw error;
      } finally {
        try {
          await options.runner.close();
        } catch (closeError) {
          if (streamError === undefined) {
            // Stream succeeded but close failed → runner_close_failed takes precedence
            throw new RunnerProtocolError(
              'runner_close_failed',
              'Runner close failed after successful stream completion.'
            );
          }
          // Stream already failed — don't mask the original error with close failure
        }
      }
    }
  };
}
