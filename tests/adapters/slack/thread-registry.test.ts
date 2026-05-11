import { describe, it, expect } from 'vitest';
import { ThreadRegistry } from '../../../src/adapters/slack/thread-registry.js';

describe('ThreadRegistry', () => {
  it('starts empty: resolve returns undefined for any key', () => {
    const registry = new ThreadRegistry();
    expect(registry.resolve('any-ts')).toBeUndefined();
  });

  it('register then resolve returns the request_id', () => {
    const registry = new ThreadRegistry();
    registry.register('1234567890.000001', 'request-abc');
    expect(registry.resolve('1234567890.000001')).toBe('request-abc');
  });

  it('resolve returns undefined for an unregistered key', () => {
    const registry = new ThreadRegistry();
    registry.register('1234567890.000001', 'request-abc');
    expect(registry.resolve('9999999999.000001')).toBeUndefined();
  });

  it('re-registering the same thread_ts overwrites the previous request_id', () => {
    const registry = new ThreadRegistry();
    registry.register('1234567890.000001', 'request-first');
    registry.register('1234567890.000001', 'request-second');
    expect(registry.resolve('1234567890.000001')).toBe('request-second');
  });

  it('multiple thread_ts entries are independent', () => {
    const registry = new ThreadRegistry();
    registry.register('ts-one', 'request-one');
    registry.register('ts-two', 'request-two');
    expect(registry.resolve('ts-one')).toBe('request-one');
    expect(registry.resolve('ts-two')).toBe('request-two');
  });

  it('rootTimestamps() returns empty array when nothing registered', () => {
    const registry = new ThreadRegistry();
    expect(registry.rootTimestamps()).toEqual([]);
  });

  it('rootTimestamps() returns all registered timestamps', () => {
    const registry = new ThreadRegistry();
    registry.register('ts-one', 'request-one');
    registry.register('ts-two', 'request-two');
    const timestamps = registry.rootTimestamps();
    expect(timestamps).toHaveLength(2);
    expect(timestamps).toContain('ts-one');
    expect(timestamps).toContain('ts-two');
  });
});
