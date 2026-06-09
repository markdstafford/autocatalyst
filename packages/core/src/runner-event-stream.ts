import { runnerEventSchema, type RunnerEvent, type RunnerTerminalResultEvent } from '@autocatalyst/api-contract';
import { RunnerProtocolError } from '@autocatalyst/execution';

export interface ConsumeRunnerEventStreamOptions {
  readonly events: AsyncIterable<unknown>;
  readonly runId: string;
  readonly onEvent?: (event: RunnerEvent) => void | Promise<void>;
}

export interface ConsumeRunnerEventStreamResult {
  readonly terminalEvent: RunnerTerminalResultEvent;
}

export async function consumeRunnerEventStream(
  options: ConsumeRunnerEventStreamOptions
): Promise<ConsumeRunnerEventStreamResult> {
  let terminalEvent: RunnerTerminalResultEvent | null = null;

  for await (const rawEvent of options.events) {
    // 1. Validate event schema
    const parseResult = runnerEventSchema.safeParse(rawEvent);
    if (!parseResult.success) {
      throw new RunnerProtocolError(
        'invalid_event',
        `Invalid runner event: ${parseResult.error.message}`
      );
    }
    const event = parseResult.data;

    // 2. Check runId
    if (event.runId !== options.runId) {
      throw new RunnerProtocolError(
        'wrong_run',
        `Event run ID '${event.runId}' does not match expected '${options.runId}'.`
      );
    }

    // 3. Check if we already have a terminal event
    if (terminalEvent !== null) {
      if (event.type === 'runner_terminal_result') {
        throw new RunnerProtocolError('duplicate_terminal_result', 'Duplicate terminal result event.');
      } else {
        throw new RunnerProtocolError(
          'event_after_terminal',
          `Non-terminal event '${event.type}' after terminal.`
        );
      }
    }

    // 4. Track terminal event
    if (event.type === 'runner_terminal_result') {
      terminalEvent = event as RunnerTerminalResultEvent;
    }

    // 5. Call onEvent with validated event
    if (options.onEvent !== undefined) {
      try {
        await options.onEvent(event);
      } catch {
        throw new RunnerProtocolError(
          'runner_failed',
          'Telemetry onEvent hook threw during event processing.'
        );
      }
    }
  }

  // After stream completes, check we got a terminal
  if (terminalEvent === null) {
    throw new RunnerProtocolError(
      'missing_terminal_result',
      'Runner stream completed without a terminal result event.'
    );
  }

  return { terminalEvent };
}
