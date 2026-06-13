import {
  RunnerProtocolError,
  validateExecutionBoundaryEventStream,
  normalizeFailureReasonForPublicSurface,
  type ExecutionTerminalResultEvent
} from '@autocatalyst/execution';
import {
  clientRunEventSchema,
  type ClientRunEvent,
  type JsonValue,
  type RunnerTerminalResultClientEvent
} from '@autocatalyst/api-contract';
import type { RunWorkResult } from './orchestrator.js';
import type { RunEventStore } from './run-events.js';

export interface RunnerEventConsumerDependencies {
  readonly eventsStore: RunEventStore;
}

export interface ConsumeRunnerEventsInput extends RunnerEventConsumerDependencies {
  readonly events: AsyncIterable<unknown>;
  readonly runId: string;
  readonly tenant: string;
}

export interface ConsumeRunnerEventsResult {
  readonly workResult: RunWorkResult;
  readonly checkpointResult?: JsonValue;
}

function toClientTerminalEvent(event: ExecutionTerminalResultEvent): RunnerTerminalResultClientEvent {
  const base: RunnerTerminalResultClientEvent = {
    id: event.id,
    type: 'runner_terminal_result',
    runId: event.runId,
    step: event.step,
    importance: event.importance,
    createdAt: event.createdAt,
    result: event.result,
    ...(event.resultContract !== undefined ? { resultContract: event.resultContract } : {})
  };
  return base;
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
        reason: normalizeFailureReasonForPublicSurface(event.result.reason) ?? 'runner_failed_before_terminal_result'
      };
  }
}

class AppendFailedError extends Error {
  constructor() { super('Control plane failed to append runner event.'); this.name = 'AppendFailedError'; }
}

export async function consumeRunnerEvents(input: ConsumeRunnerEventsInput): Promise<ConsumeRunnerEventsResult> {
  const scope = { runId: input.runId, tenant: input.tenant };
  let terminalEvent: ExecutionTerminalResultEvent | undefined;
  let terminalSeen = false;
  let appendFailedPreTerminal = false;

  try {
    for await (const event of validateExecutionBoundaryEventStream(input.events, input.runId)) {
      if (event.type === 'runner_terminal_result') {
        terminalSeen = true;
        terminalEvent = event;
        const clientEvent: ClientRunEvent = toClientTerminalEvent(event);
        try {
          await input.eventsStore.append({ scope, event: clientEvent });
        } catch {
          // Append failure on terminal — control plane fail (don't re-throw).
          return {
            workResult: { directive: 'fail', reason: 'Control plane failed to append runner event.' }
          };
        }
        continue;
      }
      const clientEvent: ClientRunEvent = clientRunEventSchema.parse(event);
      try {
        await input.eventsStore.append({ scope, event: clientEvent });
      } catch {
        appendFailedPreTerminal = true;
        throw new AppendFailedError();
      }
    }
  } catch (error) {
    if (error instanceof AppendFailedError || appendFailedPreTerminal) {
      return { workResult: { directive: 'fail', reason: 'Control plane failed to append runner event.' } };
    }
    if (terminalSeen && !(error instanceof RunnerProtocolError)) {
      throw new RunnerProtocolError('runner_failed', 'Runner threw after terminal result during drain.');
    }
    // All other errors (RunnerProtocolError, materialization errors, runner throws) re-throw.
    throw error;
  }

  if (terminalEvent === undefined) {
    throw new RunnerProtocolError('missing_terminal_result', 'No terminal event.');
  }

  const workResult = mapTerminalToWorkResult(terminalEvent);
  if (workResult.directive === 'advance' && workResult.result !== undefined) {
    return { workResult, checkpointResult: workResult.result as JsonValue };
  }
  return { workResult };
}
