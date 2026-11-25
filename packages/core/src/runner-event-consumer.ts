import {
  RunnerProtocolError,
  validateExecutionBoundaryEventStream,
  normalizeFailureReasonForPublicSurface,
  type ExecutionBoundaryEvent,
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
  readonly privateSpecResult?: boolean;
  readonly runId: string;
  readonly tenant: string;
}

export interface ConsumeRunnerEventsResult {
  readonly workResult: RunWorkResult;
  readonly checkpointResult?: JsonValue;
  readonly sessionMetadata?: ExecutionTerminalResultEvent['sessionMetadata'];
}

function toClientTerminalEvent(event: ExecutionTerminalResultEvent, hideResult = false): RunnerTerminalResultClientEvent {
  const reason = event.result.directive === 'fail' ? normalizeFailureReasonForPublicSurface(event.result.reason) : undefined;
  const result = hideResult
    ? { directive: event.result.directive, ...(reason ? { reason } : {}) }
    : event.result;
  const base: RunnerTerminalResultClientEvent = {
    id: event.id,
    type: 'runner_terminal_result',
    runId: event.runId,
    step: event.step,
    importance: event.importance,
    createdAt: event.createdAt,
    result,
    ...(event.resultContract !== undefined ? { resultContract: event.resultContract } : {})
  };
  return base;
}

/** Publish content-free activity for private spec roles, never their scratch transcript.
 * Free-form fields (including tool names and model-supplied progress labels) are private.
 */
function publicSpecActivity(event: Exclude<ExecutionBoundaryEvent, ExecutionTerminalResultEvent>): ClientRunEvent | undefined {
  switch (event.type) {
    case 'runner_assistant_turn':
      return { ...event, message: { role: 'assistant', content: 'Assistant turn' } };
    case 'runner_tool_activity': {
      const { action, status } = event.tool;
      return { ...event, tool: {
        name: 'Tool',
        action: action === 'invoke' || action === 'result' ? action : 'activity',
        status: status === 'started' || status === 'completed' || status === 'failed' ? status : 'recorded'
      } };
    }
    case 'runner_progress': {
      const progress = event.progress;
      if (progress.kind === 'task_progress') {
        return { ...event, progress: { ...progress, label: 'Session progress' } };
      }
      return { ...event, progress: { kind: 'intent', summary: 'Progress reported' } };
    }
    default:
      return undefined;
  }
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
        const clientEvent: ClientRunEvent = toClientTerminalEvent(event, input.privateSpecResult);
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
      const publicEvent = input.privateSpecResult ? publicSpecActivity(event) : event;
      if (publicEvent === undefined) continue;
      const clientEvent: ClientRunEvent = clientRunEventSchema.parse(publicEvent);
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
  const sessionMetadata = terminalEvent.sessionMetadata;
  if (workResult.directive === 'advance' && workResult.result !== undefined) {
    return {
      workResult,
      checkpointResult: workResult.result as JsonValue,
      ...(sessionMetadata !== undefined ? { sessionMetadata } : {})
    };
  }
  return {
    workResult,
    ...(sessionMetadata !== undefined ? { sessionMetadata } : {})
  };
}
