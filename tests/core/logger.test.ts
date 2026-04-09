import { describe, it, expect } from 'vitest';
import { createLogger } from '../../src/core/logger.js';

describe('createLogger', () => {
  it('produces a pino instance with the given component name', () => {
    const logger = createLogger('test-component');
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.error).toBe('function');
  });

  it('outputs valid JSON with required fields', () => {
    const chunks: string[] = [];
    const logger = createLogger('test-component', {
      destination: { write: (chunk: string) => { chunks.push(chunk); } },
    });

    logger.info({ event: 'test.event' }, 'test message');

    expect(chunks.length).toBe(1);
    const parsed = JSON.parse(chunks[0]);
    expect(parsed.component).toBe('test-component');
    expect(parsed.event).toBe('test.event');
    expect(parsed.level).toBeDefined();
    expect(parsed.timestamp).toBeDefined();
    expect(parsed.pid).toBeUndefined();
    expect(parsed.hostname).toBeUndefined();
  });

  it('includes timestamp as ISO 8601', () => {
    const chunks: string[] = [];
    const logger = createLogger('test-component', {
      destination: { write: (chunk: string) => { chunks.push(chunk); } },
    });

    logger.info({ event: 'test.event' }, 'msg');

    const parsed = JSON.parse(chunks[0]);
    expect(() => new Date(parsed.timestamp)).not.toThrow();
    expect(new Date(parsed.timestamp).toISOString()).toBe(parsed.timestamp);
  });
});
