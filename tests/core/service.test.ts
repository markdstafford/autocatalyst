import { describe, it, expect } from 'vitest';
import { Service } from '../../src/core/service.js';
import type { LoadedConfig } from '../../src/types/config.js';

function makeConfig(): LoadedConfig {
  return {
    config: { polling: { interval_ms: 100 } },
    promptTemplate: 'test prompt',
    filePath: '/test/WORKFLOW.md',
  };
}

function captureLog() {
  const entries: Record<string, unknown>[] = [];
  return {
    entries,
    destination: { write: (chunk: string) => { entries.push(JSON.parse(chunk)); } },
  };
}

describe('Service', () => {
  it('start() logs service.ready', async () => {
    const log = captureLog();
    const service = new Service(makeConfig(), { logDestination: log.destination });
    service.start();
    await new Promise(r => setTimeout(r, 50));
    service.stop();
    await service.stopped;

    const events = log.entries.map(e => e.event);
    expect(events).toContain('service.ready');
  });

  it('stop() logs service.stopping then service.stopped', async () => {
    const log = captureLog();
    const service = new Service(makeConfig(), { logDestination: log.destination });
    service.start();
    await new Promise(r => setTimeout(r, 50));
    service.stop();
    await service.stopped;

    const events = log.entries.map(e => e.event);
    const stoppingIdx = events.indexOf('service.stopping');
    const stoppedIdx = events.indexOf('service.stopped');
    expect(stoppingIdx).toBeGreaterThan(-1);
    expect(stoppedIdx).toBeGreaterThan(stoppingIdx);
  });

  it('double stop() does not crash', async () => {
    const log = captureLog();
    const service = new Service(makeConfig(), { logDestination: log.destination });
    service.start();
    service.stop();
    expect(() => service.stop()).not.toThrow();
    await service.stopped;
  });

  it('stop() before start() does not crash', async () => {
    const log = captureLog();
    const service = new Service(makeConfig(), { logDestination: log.destination });
    expect(() => service.stop()).not.toThrow();
  });
});
