import { describe, expect, it, vi } from 'vitest';
import { HandlerRegistryImpl } from '../../src/core/handler-registry.js';

describe('HandlerRegistryImpl', () => {
  it('resolves handlers by explicit event, stage, and intent route', () => {
    const registry = new HandlerRegistryImpl();
    const handler = vi.fn();
    registry.register(
      {
        event_type: 'thread_message',
        stage: 'reviewing_spec',
        intent: 'feedback',
      },
      handler,
    );

    expect(registry.resolve({
      event_type: 'thread_message',
      stage: 'reviewing_spec',
      intent: 'feedback',
    })).toBe(handler);
  });

  it('routes all artifact kinds for a stage and intent to the same handler', () => {
    const registry = new HandlerRegistryImpl();
    const handler = vi.fn();
    registry.register(
      {
        event_type: 'thread_message',
        stage: 'reviewing_spec',
        intent: 'feedback',
      },
      handler,
    );

    expect(registry.resolve({
      event_type: 'thread_message',
      stage: 'reviewing_spec',
      intent: 'feedback',
      artifact_kind: 'bug_triage',
    } as never)).toBe(handler);
  });

  it('throws on duplicate route registration', () => {
    const registry = new HandlerRegistryImpl();
    const route = {
      event_type: 'new_request' as const,
      stage: 'intake' as const,
      intent: 'idea',
    };
    registry.register(route, vi.fn());

    expect(() => registry.register(route, vi.fn())).toThrow(/already registered/i);
  });
});
