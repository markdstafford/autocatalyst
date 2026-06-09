import type { ExecutionContext } from '@autocatalyst/api-contract';
import {
  RunnerProtocolError,
  ExecutionMaterializationError,
  validateExecutionBoundaryEventStream
} from '@autocatalyst/execution';
import type { ExecutionBoundaryEvent, ExecutionEntryPoint, ExecutionTerminalResultEvent } from '@autocatalyst/execution';
import type { RunWorkInput, RunWorkResult, RunUnitOfWork } from './orchestrator.js';

export interface ExecutionRunUnitOfWorkOptions {
  readonly execute: ExecutionEntryPoint;
  readonly resolveContext: (input: RunWorkInput) => Promise<ExecutionContext>;
  readonly onEvent?: (event: ExecutionBoundaryEvent) => void | Promise<void>;
}

export function createExecutionRunUnitOfWork(options: ExecutionRunUnitOfWorkOptions): RunUnitOfWork {
  return {
    async run(input: RunWorkInput): Promise<RunWorkResult> {
      const context = await options.resolveContext(input);
      const events = options.execute.execute({ context, correlationId: input.runId });

      let terminalEvent: ExecutionTerminalResultEvent | undefined;
      let terminalSeen = false;
      try {
        for await (const event of validateExecutionBoundaryEventStream(events, input.runId)) {
          if (options.onEvent !== undefined) {
            try {
              await options.onEvent(event);
            } catch {
              throw new RunnerProtocolError('runner_failed', 'Telemetry onEvent hook threw during event processing.');
            }
          }
          if (event.type === 'runner_terminal_result') {
            terminalSeen = true;
            terminalEvent = event;
          }
        }
      } catch (error) {
        if (error instanceof RunnerProtocolError) {
          throw error;
        }
        // Stream threw after terminal → protocol violation
        if (terminalSeen) {
          throw new RunnerProtocolError('runner_failed', 'Runner threw after terminal result during drain.');
        }
        // Runner threw before terminal → fail directive with sanitized reason
        let reason: string;
        if (error instanceof ExecutionMaterializationError) {
          reason = `Execution failed: ${error.code}`;
        } else {
          reason = 'Runner failed before terminal result.';
        }
        return { directive: 'fail', reason };
      }

      if (terminalEvent === undefined) {
        // validateExecutionBoundaryEventStream throws missing_terminal_result, so this is unreachable
        throw new RunnerProtocolError('missing_terminal_result', 'No terminal event.');
      }

      return mapTerminalToWorkResult(terminalEvent);
    }
  };
}

function mapTerminalToWorkResult(event: ExecutionTerminalResultEvent): RunWorkResult {
  switch (event.result.directive) {
    case 'advance':
      return {
        directive: 'advance',
        ...(event.result.result !== undefined ? { result: event.result.result } : {})
      };
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
