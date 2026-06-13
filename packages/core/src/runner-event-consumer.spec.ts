import { describe, expect, it } from 'vitest';

import type { ExecutionBoundaryEvent } from '@autocatalyst/execution';
import { InMemoryRetainedRunEventStore } from './run-events.js';
import { consumeRunnerEvents } from './runner-event-consumer.js';

const runId = 'run_1';
const tenant = 'tenant_1';

function makeTerminalEvent(
  directive: 'advance' | 'needs_input' | 'fail',
  overrides: Record<string, unknown> = {}
): ExecutionBoundaryEvent {
  const result: Record<string, unknown> = { directive, ...overrides };
  return {
    id: 'evt_terminal',
    type: 'runner_terminal_result',
    runId,
    step: 'implement',
    importance: 'normal',
    createdAt: '2026-06-09T00:00:00.000Z',
    result
  } as ExecutionBoundaryEvent;
}

async function consumeEvents(events: ExecutionBoundaryEvent[]) {
  const store = new InMemoryRetainedRunEventStore();
  return consumeRunnerEvents({
    eventsStore: store,
    events: (async function* () { for (const e of events) yield e; })(),
    runId,
    tenant
  });
}

describe('consumeRunnerEvents — fail reason normalization', () => {
  it('preserves allowlisted terminal fail reasons', async () => {
    const result = await consumeEvents([makeTerminalEvent('fail', { reason: 'schema_validation_failed' })]);
    expect(result.workResult).toEqual({ directive: 'fail', reason: 'schema_validation_failed' });
  });

  it('preserves known safe fail phrases', async () => {
    const result = await consumeEvents([makeTerminalEvent('fail', { reason: 'Runner failed before terminal result.' })]);
    expect(result.workResult).toEqual({ directive: 'fail', reason: 'Runner failed before terminal result.' });
  });

  it('replaces unknown terminal fail reasons before returning work results', async () => {
    const sentinel = 'sk-test-secret';
    const result = await consumeEvents([
      makeTerminalEvent('fail', { reason: `raw body token=${sentinel} /Users/mark/private` })
    ]);
    expect(result.workResult).toEqual({ directive: 'fail', reason: 'runner_failed_before_terminal_result' });
    expect(JSON.stringify(result.workResult)).not.toContain(sentinel);
  });

  it('uses safe fallback code when reason is missing', async () => {
    const result = await consumeEvents([makeTerminalEvent('fail')]);
    expect(result.workResult).toEqual({ directive: 'fail', reason: 'runner_failed_before_terminal_result' });
  });

  it('advance directive passes through unchanged', async () => {
    const result = await consumeEvents([makeTerminalEvent('advance', { result: { ok: true } })]);
    expect(result.workResult).toEqual({ directive: 'advance', result: { ok: true } });
  });
});
