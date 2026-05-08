import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

  it('default destination writes to fd 2 (stderr), not fd 1 (stdout)', () => {
    const stdoutWrites: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array) => {
      stdoutWrites.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    };
    try {
      const logger = createLogger('default-dest-test');
      logger.info({ event: 'test.default_dest' }, 'probe');
      (logger as unknown as { flush?: () => void }).flush?.();
    } finally {
      process.stdout.write = origWrite;
    }
    expect(stdoutWrites.filter(s => s.includes('test.default_dest'))).toHaveLength(0);
  });
});

describe('LOG_PRETTY env var', () => {
  let originalLogPretty: string | undefined;

  beforeEach(() => {
    originalLogPretty = process.env.LOG_PRETTY;
  });

  afterEach(() => {
    if (originalLogPretty === undefined) {
      delete process.env.LOG_PRETTY;
    } else {
      process.env.LOG_PRETTY = originalLogPretty;
    }
  });

  it('does not throw when LOG_PRETTY=true and pino-pretty is available', () => {
    process.env.LOG_PRETTY = 'true';
    expect(() => createLogger('pretty-test')).not.toThrow();
  });

  it('explicit destination overrides LOG_PRETTY transport', () => {
    process.env.LOG_PRETTY = 'true';
    const chunks: string[] = [];
    const logger = createLogger('pretty-override-test', {
      destination: { write: (chunk: string) => { chunks.push(chunk); } },
    });
    logger.info({ event: 'test.pretty_override' }, 'hello');
    expect(chunks.length).toBe(1);
    const parsed = JSON.parse(chunks[0]);
    expect(parsed.event).toBe('test.pretty_override');
  });
});
