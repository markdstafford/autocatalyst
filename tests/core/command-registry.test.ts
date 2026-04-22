import { describe, it, expect, vi } from 'vitest';
import { CommandRegistryImpl } from '../../src/core/command-registry.js';
import type { CommandEvent } from '../../src/types/commands.js';

function makeEvent(overrides: Partial<CommandEvent> = {}): CommandEvent {
  return {
    command: 'test.cmd',
    args: [],
    source: 'slack',
    channel_id: 'C123',
    thread_ts: '100.0',
    author: 'U001',
    received_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('CommandRegistryImpl', () => {
  it('register then dispatch invokes handler with event and reply', async () => {
    const registry = new CommandRegistryImpl();
    const handler = vi.fn().mockResolvedValue(undefined);
    const reply = vi.fn().mockResolvedValue(undefined);
    registry.register('foo', handler);
    const event = makeEvent({ command: 'foo' });
    await registry.dispatch('foo', event, reply);
    expect(handler).toHaveBeenCalledWith(event, reply);
  });

  it('register with usage string — getUsage returns that string', () => {
    const registry = new CommandRegistryImpl();
    registry.register('foo', vi.fn(), 'do the foo thing');
    expect(registry.getUsage('foo')).toBe('do the foo thing');
  });

  it('getUsage on unregistered command returns undefined', () => {
    const registry = new CommandRegistryImpl();
    expect(registry.getUsage('nonexistent')).toBeUndefined();
  });

  it('dispatch on unknown command throws with descriptive message', async () => {
    const registry = new CommandRegistryImpl();
    const event = makeEvent({ command: 'unknown' });
    const reply = vi.fn();
    await expect(registry.dispatch('unknown', event, reply)).rejects.toThrow(/unknown/i);
  });

  it('has returns true for registered, false for unregistered', () => {
    const registry = new CommandRegistryImpl();
    registry.register('bar', vi.fn());
    expect(registry.has('bar')).toBe(true);
    expect(registry.has('baz')).toBe(false);
  });

  it('list returns all registered command names', () => {
    const registry = new CommandRegistryImpl();
    registry.register('a', vi.fn());
    registry.register('b', vi.fn());
    expect(registry.list()).toEqual(expect.arrayContaining(['a', 'b']));
    expect(registry.list()).toHaveLength(2);
  });

  it('list returns empty array when no commands registered', () => {
    const registry = new CommandRegistryImpl();
    expect(registry.list()).toEqual([]);
  });

  it('re-registering a command name overwrites the previous handler', async () => {
    const registry = new CommandRegistryImpl();
    const handler1 = vi.fn().mockResolvedValue(undefined);
    const handler2 = vi.fn().mockResolvedValue(undefined);
    registry.register('foo', handler1);
    registry.register('foo', handler2);
    const event = makeEvent({ command: 'foo' });
    const reply = vi.fn();
    await registry.dispatch('foo', event, reply);
    expect(handler2).toHaveBeenCalledOnce();
    expect(handler1).not.toHaveBeenCalled();
  });
});
