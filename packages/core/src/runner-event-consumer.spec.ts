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

  it('preserves transient_provider_failure terminal fail reasons', async () => {
    const result = await consumeEvents([makeTerminalEvent('fail', { reason: 'transient_provider_failure' })]);
    expect(result.workResult).toEqual({ directive: 'fail', reason: 'transient_provider_failure' });
  });
});

it('exposes content-free spec activity without publishing private scratch content or result bytes', async () => {
  const store = new InMemoryRetainedRunEventStore();
  const scope = { runId, tenant };
  const privateText = 'unpublished candidate scratch sentinel';
  const base = { runId, step: 'spec.author', importance: 'normal', createdAt: '2026-06-09T00:00:00.000Z' } as const;
  const events: ExecutionBoundaryEvent[] = [
    { ...base, id: 'turn', type: 'runner_assistant_turn', message: { role: privateText, content: privateText } },
    { ...base, id: 'tool', type: 'runner_tool_activity', tool: { name: privateText, action: privateText, status: privateText } },
    { ...base, id: 'progress', type: 'runner_progress', progress: { kind: 'task_progress', label: privateText, completed: 1, total: 3 } },
    { ...base, id: 'checkpoint', type: 'runner_step_checkpoint', checkpoint: { durable: true, name: privateText, data: {} } },
    { ...base, id: 'notice', type: 'runner_notification', notification: { severity: 'info', message: privateText } },
    makeTerminalEvent('advance', { result: { body: privateText } })
  ];
  const result = await consumeRunnerEvents({
    eventsStore: store, ...scope, privateSpecResult: true,
    events: (async function* () { yield* events; })()
  });
  expect(result.workResult).toMatchObject({ result: { body: privateText } });
  const replay = await store.replayAfter({ ...scope, replay: 'retained' });
  expect(replay.status).toBe('ok');
  if (replay.status !== 'ok') return;
  expect(replay.events.map(event => event.type)).toEqual([
    'runner_assistant_turn', 'runner_tool_activity', 'runner_progress', 'runner_terminal_result'
  ]);
  expect(replay.events[2]).toMatchObject({ progress: { label: 'Session progress', completed: 1, total: 3 } });
  expect(JSON.stringify(replay.events)).not.toContain(privateText);
});
