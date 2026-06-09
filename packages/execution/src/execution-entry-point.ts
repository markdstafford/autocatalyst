import type { ExecutionContext, RunnerEvent } from '@autocatalyst/api-contract';
import type { MaterializedExecutionEnvironment } from './materialized-environment.js';
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
      try {
        for await (const event of options.runner.run(runnerInput)) {
          yield event;
        }
      } finally {
        await options.runner.close();
      }
    }
  };
}
