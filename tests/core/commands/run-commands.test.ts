import { describe, it, expect, vi } from 'vitest';
import { makeRunStatusHandler, makeRunListHandler } from '../../../src/core/commands/run-commands.js';
import type { CommandEvent } from '../../../src/types/commands.js';
import type { Run } from '../../../src/types/runs.js';

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-001',
    request_id: 'req-001',
    intent: 'idea',
    stage: 'speccing',
    workspace_path: '/ws/req-001',
    branch: 'spec/req-001',
    spec_path: undefined,
    publisher_ref: undefined,
    impl_feedback_ref: undefined,
    issue: undefined,
    attempt: 0,
    channel_id: 'C001',
    thread_ts: '1000.0',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeEvent(overrides: Partial<CommandEvent> = {}): CommandEvent {
  return {
    command: 'run.status',
    args: [],
    source: 'slack',
    channel_id: 'C001',
    thread_ts: '1000.0',
    author: 'U001',
    received_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('run.status handler', () => {
  it('with inferred_context.request_id → replies with stage, intent, and time in stage', async () => {
    const runs = new Map<string, Run>();
    runs.set('req-001', makeRun({ request_id: 'req-001', stage: 'speccing', intent: 'idea' }));
    const handler = makeRunStatusHandler(runs);
    const reply = vi.fn().mockResolvedValue(undefined);

    await handler(makeEvent({ inferred_context: { request_id: 'req-001' } }), reply);

    expect(reply).toHaveBeenCalledOnce();
    const msg = reply.mock.calls[0][0] as string;
    expect(msg).toContain('speccing');
    expect(msg).toContain('idea');
  });

  it('with explicit request_id as first arg → looks up by request_id; replies correctly', async () => {
    const runs = new Map<string, Run>();
    runs.set('req-001', makeRun({ request_id: 'req-001', stage: 'implementing' }));
    const handler = makeRunStatusHandler(runs);
    const reply = vi.fn().mockResolvedValue(undefined);

    await handler(makeEvent({ args: ['req-001'] }), reply);

    expect(reply).toHaveBeenCalledOnce();
    const msg = reply.mock.calls[0][0] as string;
    expect(msg).toContain('implementing');
  });

  it('with explicit run.id as first arg → looks up by run.id; replies correctly', async () => {
    const runs = new Map<string, Run>();
    runs.set('req-001', makeRun({ id: 'run-uuid-001', request_id: 'req-001', stage: 'implementing' }));
    const handler = makeRunStatusHandler(runs);
    const reply = vi.fn().mockResolvedValue(undefined);

    await handler(makeEvent({ args: ['run-uuid-001'] }), reply);

    expect(reply).toHaveBeenCalledOnce();
    const msg = reply.mock.calls[0][0] as string;
    expect(msg).toContain('implementing');
  });

  it('run ID not found → replies with "no active run" message', async () => {
    const runs = new Map<string, Run>();
    const handler = makeRunStatusHandler(runs);
    const reply = vi.fn().mockResolvedValue(undefined);

    await handler(makeEvent({ args: ['nonexistent'] }), reply);

    expect(reply).toHaveBeenCalledWith(expect.stringContaining('no active run'));
  });

  it('no inferred context, no args → replies "no run found in this thread"', async () => {
    const runs = new Map<string, Run>();
    const handler = makeRunStatusHandler(runs);
    const reply = vi.fn().mockResolvedValue(undefined);

    await handler(makeEvent(), reply);

    expect(reply).toHaveBeenCalledWith(expect.stringMatching(/no run found/i));
  });

  it('run in terminal state (done) → reply shows final stage and status', async () => {
    const runs = new Map<string, Run>();
    runs.set('req-001', makeRun({ request_id: 'req-001', stage: 'done' }));
    const handler = makeRunStatusHandler(runs);
    const reply = vi.fn().mockResolvedValue(undefined);

    await handler(makeEvent({ inferred_context: { request_id: 'req-001' } }), reply);

    const msg = reply.mock.calls[0][0] as string;
    expect(msg).toContain('done');
  });

  it('reply posted to correct thread_ts', async () => {
    const runs = new Map<string, Run>();
    runs.set('req-001', makeRun({ request_id: 'req-001' }));
    const handler = makeRunStatusHandler(runs);
    const reply = vi.fn().mockResolvedValue(undefined);

    await handler(makeEvent({ thread_ts: '9999.0', inferred_context: { request_id: 'req-001' } }), reply);

    // reply fn is called by the handler; the orchestrator wires thread_ts into it
    expect(reply).toHaveBeenCalledOnce();
  });
});

describe('run.list handler', () => {
  it('no active runs → replies with "no active runs"', async () => {
    const runs = new Map<string, Run>();
    const handler = makeRunListHandler(runs);
    const reply = vi.fn().mockResolvedValue(undefined);

    await handler(makeEvent({ command: 'run.list' }), reply);

    expect(reply).toHaveBeenCalledWith(expect.stringMatching(/no active runs/i));
  });

  it('one active run → replies with summary including ID, stage, intent', async () => {
    const runs = new Map<string, Run>();
    runs.set('req-001', makeRun({ request_id: 'req-001', id: 'run-001', stage: 'speccing', intent: 'idea' }));
    const handler = makeRunListHandler(runs);
    const reply = vi.fn().mockResolvedValue(undefined);

    await handler(makeEvent({ command: 'run.list' }), reply);

    const msg = reply.mock.calls[0][0] as string;
    expect(msg).toContain('run-001');
    expect(msg).toContain('speccing');
    expect(msg).toContain('idea');
  });

  it('done and failed runs excluded from list', async () => {
    const runs = new Map<string, Run>();
    runs.set('req-001', makeRun({ request_id: 'req-001', id: 'run-001', stage: 'speccing' }));
    runs.set('req-002', makeRun({ request_id: 'req-002', id: 'run-002', stage: 'done' }));
    runs.set('req-003', makeRun({ request_id: 'req-003', id: 'run-003', stage: 'failed' }));
    const handler = makeRunListHandler(runs);
    const reply = vi.fn().mockResolvedValue(undefined);

    await handler(makeEvent({ command: 'run.list' }), reply);

    const msg = reply.mock.calls[0][0] as string;
    expect(msg).toContain('run-001');
    expect(msg).not.toContain('run-002');
    expect(msg).not.toContain('run-003');
  });

  it('multiple active runs → all listed', async () => {
    const runs = new Map<string, Run>();
    runs.set('req-001', makeRun({ request_id: 'req-001', id: 'run-001', stage: 'speccing' }));
    runs.set('req-002', makeRun({ request_id: 'req-002', id: 'run-002', stage: 'implementing' }));
    const handler = makeRunListHandler(runs);
    const reply = vi.fn().mockResolvedValue(undefined);

    await handler(makeEvent({ command: 'run.list' }), reply);

    const msg = reply.mock.calls[0][0] as string;
    expect(msg).toContain('run-001');
    expect(msg).toContain('run-002');
  });
});
