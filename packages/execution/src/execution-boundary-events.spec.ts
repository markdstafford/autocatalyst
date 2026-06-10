import { describe, expect, it } from 'vitest';

import {
  validateExecutionBoundaryEvent,
  validateExecutionBoundaryEventStream
} from './execution-boundary-events.js';
import { RunnerProtocolError } from './runner.js';

const runId = 'run_1';

function progressEvent(over?: Record<string, unknown>): unknown {
  return {
    id: 'evt_progress',
    type: 'runner_progress',
    runId,
    step: 'implement',
    importance: 'normal',
    createdAt: '2026-06-09T00:00:00.000Z',
    progress: { kind: 'intent', summary: 'go' },
    ...over
  };
}

function terminalEvent(over?: Record<string, unknown>): unknown {
  return {
    id: 'evt_terminal',
    type: 'runner_terminal_result',
    runId,
    step: 'implement',
    importance: 'high',
    createdAt: '2026-06-09T00:00:00.000Z',
    result: { directive: 'advance', result: { ok: true } },
    ...over
  };
}

async function* iterableOf(events: readonly unknown[]): AsyncIterable<unknown> {
  for (const event of events) yield event;
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of iterable) out.push(v);
  return out;
}

describe('validateExecutionBoundaryEvent', () => {
  it('accepts a non-terminal event', () => {
    const ev = validateExecutionBoundaryEvent(progressEvent());
    expect(ev.type).toBe('runner_progress');
  });

  it('accepts a terminal handoff event with validated result', () => {
    const ev = validateExecutionBoundaryEvent(terminalEvent());
    expect(ev.type).toBe('runner_terminal_result');
  });

  it('throws invalid_event for malformed input', () => {
    expect(() => validateExecutionBoundaryEvent({ foo: 'bar' })).toThrow(RunnerProtocolError);
  });
});

describe('validateExecutionBoundaryEventStream', () => {
  it('passes through valid events ending with terminal', async () => {
    const events = await collect(
      validateExecutionBoundaryEventStream(iterableOf([progressEvent(), terminalEvent()]), runId)
    );
    expect(events.map((e) => e.type)).toEqual(['runner_progress', 'runner_terminal_result']);
  });

  it('throws wrong_run when event has different runId', async () => {
    const stream = validateExecutionBoundaryEventStream(
      iterableOf([progressEvent({ runId: 'run_other' })]),
      runId
    );
    await expect(collect(stream)).rejects.toMatchObject({
      name: 'RunnerProtocolError',
      code: 'wrong_run'
    });
  });

  it('throws duplicate_terminal_result for two terminal events', async () => {
    const stream = validateExecutionBoundaryEventStream(
      iterableOf([terminalEvent(), terminalEvent({ id: 'evt_terminal_2' })]),
      runId
    );
    await expect(collect(stream)).rejects.toMatchObject({
      name: 'RunnerProtocolError',
      code: 'duplicate_terminal_result'
    });
  });

  it('throws event_after_terminal when non-terminal follows terminal', async () => {
    const stream = validateExecutionBoundaryEventStream(
      iterableOf([terminalEvent(), progressEvent()]),
      runId
    );
    await expect(collect(stream)).rejects.toMatchObject({
      name: 'RunnerProtocolError',
      code: 'event_after_terminal'
    });
  });

  it('throws missing_terminal_result when stream ends without terminal', async () => {
    const stream = validateExecutionBoundaryEventStream(iterableOf([progressEvent()]), runId);
    await expect(collect(stream)).rejects.toMatchObject({
      name: 'RunnerProtocolError',
      code: 'missing_terminal_result'
    });
  });
});
