import { describe, it, expect } from 'vitest';
import { ThreadRegistry } from '../../../src/adapters/slack/thread-registry.js';

describe('ThreadRegistry', () => {
  it('starts empty: resolve returns undefined for any key', () => {
    const registry = new ThreadRegistry();
    expect(registry.resolve('any-ts')).toBeUndefined();
  });

  it('register then resolve returns the idea_id', () => {
    const registry = new ThreadRegistry();
    registry.register('1234567890.000001', 'idea-abc');
    expect(registry.resolve('1234567890.000001')).toBe('idea-abc');
  });

  it('resolve returns undefined for an unregistered key', () => {
    const registry = new ThreadRegistry();
    registry.register('1234567890.000001', 'idea-abc');
    expect(registry.resolve('9999999999.000001')).toBeUndefined();
  });

  it('re-registering the same thread_ts overwrites the previous idea_id', () => {
    const registry = new ThreadRegistry();
    registry.register('1234567890.000001', 'idea-first');
    registry.register('1234567890.000001', 'idea-second');
    expect(registry.resolve('1234567890.000001')).toBe('idea-second');
  });

  it('multiple thread_ts entries are independent', () => {
    const registry = new ThreadRegistry();
    registry.register('ts-one', 'idea-one');
    registry.register('ts-two', 'idea-two');
    expect(registry.resolve('ts-one')).toBe('idea-one');
    expect(registry.resolve('ts-two')).toBe('idea-two');
  });
});
