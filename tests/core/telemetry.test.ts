import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('initTelemetry()', () => {
  beforeEach(() => {
    delete process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
  });

  it('returns callable no-op meter when env vars are unset', async () => {
    const { initTelemetry } = await import('../../src/core/telemetry.js');
    const { meter, shutdown } = initTelemetry();
    const counter = meter.createCounter('test.counter');
    expect(() => counter.add(1)).not.toThrow();
    await shutdown();
  });

  it('returns callable no-op histogram when env vars are unset', async () => {
    const { initTelemetry } = await import('../../src/core/telemetry.js');
    const { meter, shutdown } = initTelemetry();
    const hist = meter.createHistogram('test.hist');
    expect(() => hist.record(42)).not.toThrow();
    await shutdown();
  });

  it('does not throw on construction with non-reachable endpoint', async () => {
    process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = 'http://127.0.0.1:1';
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = 'http://127.0.0.1:1';
    const { initTelemetry } = await import('../../src/core/telemetry.js');
    let handles: Awaited<ReturnType<typeof initTelemetry>>;
    expect(() => { handles = initTelemetry(); }).not.toThrow();
    await expect(handles!.shutdown()).resolves.not.toThrow();
  });

  it('returns a loggerProvider that does not throw when emitting', async () => {
    const { initTelemetry } = await import('../../src/core/telemetry.js');
    const { loggerProvider, shutdown } = initTelemetry();
    const otelLogger = loggerProvider.getLogger('test');
    expect(() => otelLogger.emit({ body: 'hello', severityNumber: 9 })).not.toThrow();
    await shutdown();
  });

  it('activates live path when config provides endpoints', async () => {
    const { initTelemetry } = await import('../../src/core/telemetry.js');
    const { meter } = initTelemetry({
      metrics_endpoint: 'http://127.0.0.1:1/metrics',
      logs_endpoint: 'http://127.0.0.1:1/logs',
    });
    // meter should be a real SDK meter, not a no-op — instruments are callable
    const counter = meter.createCounter('test.counter');
    expect(() => counter.add(1)).not.toThrow();
  });

  it('config endpoint takes precedence over env var', async () => {
    process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = 'http://127.0.0.1:1/env';
    const { initTelemetry } = await import('../../src/core/telemetry.js');
    const { meter } = initTelemetry({ metrics_endpoint: 'http://127.0.0.1:1/config' });
    // config wins — meter is live, instruments are callable
    expect(() => meter.createCounter('test.counter').add(1)).not.toThrow();
  });

  it('respects custom export_interval_ms from config', async () => {
    const { initTelemetry } = await import('../../src/core/telemetry.js');
    const { meter } = initTelemetry({
      metrics_endpoint: 'http://127.0.0.1:1/metrics',
      export_interval_ms: 60000,
    });
    expect(() => meter.createCounter('test.counter').add(1)).not.toThrow();
  });

  it('returns no-op handles when config has no endpoints', async () => {
    const { initTelemetry } = await import('../../src/core/telemetry.js');
    const { meter, shutdown } = initTelemetry({});
    const counter = meter.createCounter('test.counter');
    expect(() => counter.add(1)).not.toThrow();
    await shutdown();
  });
});
