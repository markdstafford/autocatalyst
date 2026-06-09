import { describe, expect, it, vi } from 'vitest';

import type { RunnerEvent } from '@autocatalyst/api-contract';
import { RunnerProtocolError } from '@autocatalyst/execution';
import { consumeRunnerEventStream } from './runner-event-stream.js';

const runId = 'run_1';

function makeTerminalEvent(overrides: Partial<RunnerEvent> = {}): RunnerEvent {
  return {
    id: 'evt_terminal',
    type: 'runner_terminal_result',
    runId,
    step: 'implement',
    importance: 'normal',
    createdAt: '2026-06-09T00:00:00.000Z',
    result: { directive: 'advance' },
    ...overrides
  } as RunnerEvent;
}

function makeProgressEvent(overrides: Partial<RunnerEvent> = {}): RunnerEvent {
  return {
    id: 'evt_progress',
    type: 'runner_progress',
    runId,
    step: 'implement',
    importance: 'low',
    createdAt: '2026-06-09T00:00:00.000Z',
    progress: { kind: 'intent', summary: 'Working on it' },
    ...overrides
  } as RunnerEvent;
}

async function* makeStream(...events: unknown[]): AsyncIterable<unknown> {
  for (const event of events) {
    yield event;
  }
}

describe('consumeRunnerEventStream', () => {
  it('valid happy-path stream yields terminal and returns it', async () => {
    const terminal = makeTerminalEvent();
    const result = await consumeRunnerEventStream({
      events: makeStream(makeProgressEvent(), terminal),
      runId
    });

    expect(result.terminalEvent.type).toBe('runner_terminal_result');
    expect(result.terminalEvent.result.directive).toBe('advance');
  });

  it('invalid event schema throws invalid_event', async () => {
    await expect(
      consumeRunnerEventStream({
        events: makeStream({ type: 'not_a_real_type', runId, id: 'x', step: 'x', importance: 'low', createdAt: '2026-06-09T00:00:00.000Z' }),
        runId
      })
    ).rejects.toMatchObject({
      name: 'RunnerProtocolError',
      code: 'invalid_event'
    });
  });

  it('wrong runId throws wrong_run', async () => {
    const wrongRunEvent: RunnerEvent = {
      id: 'evt_1',
      type: 'runner_terminal_result',
      runId: 'run_999',
      step: 'implement',
      importance: 'normal',
      createdAt: '2026-06-09T00:00:00.000Z',
      result: { directive: 'advance' }
    };

    await expect(
      consumeRunnerEventStream({
        events: makeStream(wrongRunEvent),
        runId
      })
    ).rejects.toMatchObject({
      name: 'RunnerProtocolError',
      code: 'wrong_run'
    });
  });

  it('second terminal event throws duplicate_terminal_result', async () => {
    const terminal1 = makeTerminalEvent({ id: 'evt_t1' });
    const terminal2 = makeTerminalEvent({ id: 'evt_t2' });

    await expect(
      consumeRunnerEventStream({
        events: makeStream(terminal1, terminal2),
        runId
      })
    ).rejects.toMatchObject({
      name: 'RunnerProtocolError',
      code: 'duplicate_terminal_result'
    });
  });

  it('non-terminal event after terminal throws event_after_terminal', async () => {
    const terminal = makeTerminalEvent();
    const lateProgress = makeProgressEvent({ id: 'evt_late' });

    await expect(
      consumeRunnerEventStream({
        events: makeStream(terminal, lateProgress),
        runId
      })
    ).rejects.toMatchObject({
      name: 'RunnerProtocolError',
      code: 'event_after_terminal'
    });
  });

  it('stream completes without terminal throws missing_terminal_result', async () => {
    await expect(
      consumeRunnerEventStream({
        events: makeStream(makeProgressEvent()),
        runId
      })
    ).rejects.toMatchObject({
      name: 'RunnerProtocolError',
      code: 'missing_terminal_result'
    });
  });

  it('empty stream throws missing_terminal_result', async () => {
    await expect(
      consumeRunnerEventStream({
        events: makeStream(),
        runId
      })
    ).rejects.toMatchObject({
      name: 'RunnerProtocolError',
      code: 'missing_terminal_result'
    });
  });

  it('onEvent receives all validated events', async () => {
    const onEvent = vi.fn();
    const progress = makeProgressEvent();
    const terminal = makeTerminalEvent();

    await consumeRunnerEventStream({
      events: makeStream(progress, terminal),
      runId,
      onEvent
    });

    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onEvent).toHaveBeenNthCalledWith(1, progress);
    expect(onEvent).toHaveBeenNthCalledWith(2, terminal);
  });

  it('onEvent does NOT receive rejected invalid events', async () => {
    const onEvent = vi.fn();
    const invalidEvent = { type: 'garbage', runId, id: 'x', step: 'x', importance: 'low', createdAt: '2026-06-09T00:00:00.000Z' };

    await expect(
      consumeRunnerEventStream({
        events: makeStream(invalidEvent),
        runId,
        onEvent
      })
    ).rejects.toMatchObject({ code: 'invalid_event' });

    expect(onEvent).not.toHaveBeenCalled();
  });

  it('onEvent throwing wraps error as runner_failed RunnerProtocolError', async () => {
    const onEvent = vi.fn().mockRejectedValue(new Error('telemetry failure'));
    const terminal = makeTerminalEvent();

    await expect(
      consumeRunnerEventStream({
        events: makeStream(terminal),
        runId,
        onEvent
      })
    ).rejects.toMatchObject({
      name: 'RunnerProtocolError',
      code: 'runner_failed'
    });
  });

  it('RunnerProtocolError is an instance of Error', async () => {
    await expect(
      consumeRunnerEventStream({
        events: makeStream(),
        runId
      })
    ).rejects.toBeInstanceOf(Error);
  });

  it('RunnerProtocolError is an instance of RunnerProtocolError', async () => {
    await expect(
      consumeRunnerEventStream({
        events: makeStream(),
        runId
      })
    ).rejects.toBeInstanceOf(RunnerProtocolError);
  });

  it('throws RunnerProtocolError runner_failed when generator throws after terminal', async () => {
    async function* throwAfterTerminal(): AsyncIterable<unknown> {
      yield makeTerminalEvent();
      throw new Error('Runner crashed after terminal');
    }

    await expect(
      consumeRunnerEventStream({ events: throwAfterTerminal(), runId })
    ).rejects.toMatchObject({
      name: 'RunnerProtocolError',
      code: 'runner_failed'
    });
  });
});
