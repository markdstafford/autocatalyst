import { z } from 'zod';

import {
  runnerEventSchema,
  runnerTerminalStepResultSchema
} from '@autocatalyst/api-contract';
import type { RunnerEvent } from '@autocatalyst/api-contract';

import { RunnerProtocolError } from './runner.js';

// Non-terminal events pass through as raw RunnerEvents.
const nonTerminalRunnerEventSchema = runnerEventSchema.refine(
  (event) => event.type !== 'runner_terminal_result',
  { message: 'Expected non-terminal runner event.' }
);

// Terminal events use the post-validation handoff shape.
export const executionTerminalResultEventSchema = z
  .object({
    id: z.string(),
    type: z.literal('runner_terminal_result'),
    runId: z.string(),
    step: z.string(),
    importance: z.enum(['low', 'normal', 'high']),
    createdAt: z.string().datetime(),
    result: runnerTerminalStepResultSchema,
    resultContract: z
      .object({
        step: z.string().min(1),
        schemaId: z.string().min(1)
      })
      .strict()
      .optional()
  })
  .strict();

export const executionBoundaryEventSchema = z.union([
  nonTerminalRunnerEventSchema,
  executionTerminalResultEventSchema
]);

export type ExecutionTerminalResultEvent = z.infer<typeof executionTerminalResultEventSchema>;
export type ExecutionBoundaryEvent =
  | Exclude<RunnerEvent, { type: 'runner_terminal_result' }>
  | ExecutionTerminalResultEvent;

export function validateExecutionBoundaryEvent(event: unknown): ExecutionBoundaryEvent {
  const parsed = executionBoundaryEventSchema.safeParse(event);
  if (!parsed.success) {
    throw new RunnerProtocolError('invalid_event', 'Invalid execution boundary event.');
  }
  return parsed.data as ExecutionBoundaryEvent;
}

export async function* validateExecutionBoundaryEventStream(
  events: AsyncIterable<unknown>,
  expectedRunId: string
): AsyncIterable<ExecutionBoundaryEvent> {
  let terminalSeen = false;
  for await (const raw of events) {
    const event = validateExecutionBoundaryEvent(raw);
    if (event.runId !== expectedRunId) {
      throw new RunnerProtocolError('wrong_run', 'Execution boundary event has wrong run id.');
    }
    if (event.type === 'runner_terminal_result') {
      if (terminalSeen) {
        throw new RunnerProtocolError(
          'duplicate_terminal_result',
          'Execution boundary stream emitted a duplicate terminal event.'
        );
      }
      terminalSeen = true;
      yield event;
      continue;
    }
    if (terminalSeen) {
      throw new RunnerProtocolError(
        'event_after_terminal',
        'Execution boundary stream emitted an event after the terminal event.'
      );
    }
    yield event;
  }
  if (!terminalSeen) {
    throw new RunnerProtocolError(
      'missing_terminal_result',
      'Execution boundary stream completed without a terminal event.'
    );
  }
}
