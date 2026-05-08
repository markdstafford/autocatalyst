import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Writable } from 'node:stream';
import type { LoggerProvider } from '@opentelemetry/api-logs';

describe('createLogger() OTel bridge', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('writes to stderr destination when no loggerProvider given', async () => {
    const { createLogger } = await import('../../src/core/logger.js');
    const chunks: Buffer[] = [];
    const dest = new Writable({
      write(chunk, _enc, cb) { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); cb(); },
    });
    const logger = createLogger('test-component', { destination: dest as unknown as import('pino').DestinationStream });
    logger.info({ event: 'test.event' }, 'hello');
    await new Promise(r => setImmediate(r));
    const output = Buffer.concat(chunks).toString();
    expect(output).toContain('test-component');
    expect(output).toContain('test.event');
  });

  it('calls OTel emit when live loggerProvider is provided', async () => {
    const emitMock = vi.fn();
    const fakeOtelLogger = { emit: emitMock };
    const fakeLoggerProvider = {
      getLogger: vi.fn().mockReturnValue(fakeOtelLogger),
    } as unknown as LoggerProvider;

    const { createLogger } = await import('../../src/core/logger.js');
    const chunks: Buffer[] = [];
    const dest = new Writable({
      write(chunk, _enc, cb) { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); cb(); },
    });
    const logger = createLogger('test-component', {
      destination: dest as unknown as import('pino').DestinationStream,
      loggerProvider: fakeLoggerProvider,
    });
    logger.info({ event: 'test.otel' }, 'otel message');
    // Give pino multistream time to flush to both streams
    await new Promise(r => setTimeout(r, 50));
    // Should still write to primary destination
    const output = Buffer.concat(chunks).toString();
    expect(output).toContain('test.otel');
    // Should also call OTel emit
    expect(emitMock).toHaveBeenCalledOnce();
    const record = emitMock.mock.calls[0][0];
    expect(record.body).toBe('otel message');
    expect(record.severityNumber).toBe(9); // info = 9
  });

  it('maps pino level numbers to correct OTel SeverityNumber', async () => {
    const emitMock = vi.fn();
    const fakeLoggerProvider = {
      getLogger: vi.fn().mockReturnValue({ emit: emitMock }),
    } as unknown as LoggerProvider;

    const { createLogger } = await import('../../src/core/logger.js');
    const dest = new Writable({ write(_c, _e, cb) { cb(); } });
    const logger = createLogger('test-sev', {
      destination: dest as unknown as import('pino').DestinationStream,
      loggerProvider: fakeLoggerProvider,
    });

    logger.warn({ event: 'test.warn' }, 'warn message');
    await new Promise(r => setTimeout(r, 50));
    expect(emitMock).toHaveBeenCalledOnce();
    expect(emitMock.mock.calls[0][0].severityNumber).toBe(13); // warn = 13
  });
});
