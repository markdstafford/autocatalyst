import { describe, it, expect, vi } from 'vitest';
import { makeHealthHandler, makeHelpHandler } from '../../../src/core/commands/meta-commands.js';
import type { CommandEvent, CommandRegistry } from '../../../src/types/commands.js';

function makeEvent(overrides: Partial<CommandEvent> = {}): CommandEvent {
  return {
    command: 'health',
    args: [],
    source: 'slack',
    channel_id: 'C001',
    thread_ts: '1000.0',
    author: 'U001',
    received_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeRegistry(overrides: Partial<CommandRegistry> = {}): CommandRegistry {
  return {
    register: vi.fn(),
    dispatch: vi.fn().mockResolvedValue(undefined),
    has: vi.fn().mockReturnValue(false),
    list: vi.fn().mockReturnValue([]),
    getUsage: vi.fn().mockReturnValue(undefined),
    ...overrides,
  };
}

describe('health handler', () => {
  it('adapter connected, no active runs → posts connected state and zero run count', async () => {
    const handler = makeHealthHandler(() => true, () => 0);
    const reply = vi.fn().mockResolvedValue(undefined);

    await handler(makeEvent(), reply);

    expect(reply).toHaveBeenCalledOnce();
    const msg = reply.mock.calls[0][0] as string;
    expect(msg.toLowerCase()).toContain('connected');
    expect(msg).toContain('0');
  });

  it('adapter connected, runs in flight → posts connected status and correct active run count', async () => {
    const handler = makeHealthHandler(() => true, () => 3);
    const reply = vi.fn().mockResolvedValue(undefined);

    await handler(makeEvent(), reply);

    const msg = reply.mock.calls[0][0] as string;
    expect(msg).toContain('3');
  });

  it('adapter disconnected → posts disconnected status', async () => {
    const handler = makeHealthHandler(() => false, () => 0);
    const reply = vi.fn().mockResolvedValue(undefined);

    await handler(makeEvent(), reply);

    const msg = reply.mock.calls[0][0] as string;
    expect(msg.toLowerCase()).toContain('disconnect');
  });
});

describe('help handler', () => {
  it('no args → lists all registered commands with usage strings', async () => {
    const registry = makeRegistry({
      list: vi.fn().mockReturnValue(['run.status', 'run.list', 'health', 'help']),
      getUsage: vi.fn().mockImplementation((cmd: string) => `Usage for ${cmd}`),
    });
    const handler = makeHelpHandler(registry);
    const reply = vi.fn().mockResolvedValue(undefined);

    await handler(makeEvent({ command: 'help' }), reply);

    const msg = reply.mock.calls[0][0] as string;
    expect(msg).toContain('run.status');
    expect(msg).toContain('run.list');
    expect(msg).toContain('health');
  });

  it('known command arg → posts usage string for that command', async () => {
    const registry = makeRegistry({
      has: vi.fn().mockReturnValue(true),
      getUsage: vi.fn().mockReturnValue('show status of a run'),
    });
    const handler = makeHelpHandler(registry);
    const reply = vi.fn().mockResolvedValue(undefined);

    await handler(makeEvent({ command: 'help', args: ['run.status'] }), reply);

    expect(registry.getUsage).toHaveBeenCalledWith('run.status');
    const msg = reply.mock.calls[0][0] as string;
    expect(msg).toContain('show status of a run');
  });

  it('unknown command arg → replies "unknown command: [name]"', async () => {
    const registry = makeRegistry({ has: vi.fn().mockReturnValue(false) });
    const handler = makeHelpHandler(registry);
    const reply = vi.fn().mockResolvedValue(undefined);

    await handler(makeEvent({ command: 'help', args: ['nonexistent'] }), reply);

    expect(reply).toHaveBeenCalledWith(expect.stringContaining('unknown command'));
    expect(reply).toHaveBeenCalledWith(expect.stringContaining('nonexistent'));
  });

  it('invoked via unrecognized-command fallback → same output as direct :ac-help:', async () => {
    const registry = makeRegistry({
      list: vi.fn().mockReturnValue(['run.status']),
      getUsage: vi.fn().mockReturnValue('show status'),
    });
    const handler = makeHelpHandler(registry);
    const reply1 = vi.fn().mockResolvedValue(undefined);
    const reply2 = vi.fn().mockResolvedValue(undefined);

    // Direct help invocation (no args)
    await handler(makeEvent({ command: 'help' }), reply1);
    // Fallback invocation — event.command is the unknown command, but no args provided
    await handler(makeEvent({ command: 'unknown.cmd' }), reply2);

    expect(reply1.mock.calls[0][0]).toEqual(reply2.mock.calls[0][0]);
  });
});
