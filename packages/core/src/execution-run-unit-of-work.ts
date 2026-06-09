import type { ExecutionContext, RunnerEvent, RunnerTerminalResultEvent } from '@autocatalyst/api-contract';
import { RunnerProtocolError, ExecutionMaterializationError } from '@autocatalyst/execution';
import type { ExecutionEntryPoint } from '@autocatalyst/execution';
import type { RunWorkInput, RunWorkResult, RunUnitOfWork } from './orchestrator.js';
import { consumeRunnerEventStream } from './runner-event-stream.js';

export interface ExecutionRunUnitOfWorkOptions {
  readonly execute: ExecutionEntryPoint;
  readonly resolveContext: (input: RunWorkInput) => Promise<ExecutionContext>;
  readonly onEvent?: (event: RunnerEvent) => void | Promise<void>;
}

export function createExecutionRunUnitOfWork(options: ExecutionRunUnitOfWorkOptions): RunUnitOfWork {
  return {
    async run(input: RunWorkInput): Promise<RunWorkResult> {
      // 1. Resolve declarative context
      const context = await options.resolveContext(input);

      // 2. Invoke execution entry point
      const events = options.execute.execute({ context, correlationId: input.runId });

      // 3. Consume event stream with validation
      let terminalEvent: RunnerTerminalResultEvent;
      try {
        const result = await consumeRunnerEventStream({
          events,
          runId: input.runId,
          ...(options.onEvent !== undefined ? { onEvent: options.onEvent } : {})
        });
        terminalEvent = result.terminalEvent;
      } catch (error) {
        if (error instanceof RunnerProtocolError) {
          // Protocol violations → re-throw
          throw error;
        }
        // Runner threw before terminal → fail directive with sanitized static reason
        let reason: string;
        if (error instanceof ExecutionMaterializationError) {
          reason = `Execution failed: ${error.code}`;
        } else {
          reason = 'Runner failed before terminal result.';
        }
        return { directive: 'fail', reason };
      }

      // 4. Map terminal directive to work result
      return mapTerminalToWorkResult(terminalEvent);
    }
  };
}

function mapTerminalToWorkResult(event: RunnerTerminalResultEvent): RunWorkResult {
  switch (event.result.directive) {
    case 'advance':
      return { directive: 'advance' };
    case 'needs_input':
      return {
        directive: 'needs_input',
        ...(event.result.question !== undefined ? { question: event.result.question } : {})
      };
    case 'fail':
      return {
        directive: 'fail',
        reason: event.result.reason ?? 'Runner returned a failed terminal result.'
      };
  }
}
