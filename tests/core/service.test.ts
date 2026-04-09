import { describe, it, expect, vi } from 'vitest';
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

import type { Orchestrator } from '../../src/core/orchestrator.js';

function makeMockOrchestrator(): Orchestrator {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

describe('Service — orchestrator delegation', () => {
  it('start() calls orchestrator.start()', async () => {
    const orch = makeMockOrchestrator();
    const service = new Service(makeConfig(), { orchestrator: orch });
    service.start();
    await new Promise(r => setTimeout(r, 50));
    service.stop();
    await service.stopped;

    expect(orch.start).toHaveBeenCalledTimes(1);
  });

  it('stop() calls orchestrator.stop()', async () => {
    const orch = makeMockOrchestrator();
    const service = new Service(makeConfig(), { orchestrator: orch });
    service.start();
    await new Promise(r => setTimeout(r, 50));
    service.stop();
    await service.stopped;

    expect(orch.stop).toHaveBeenCalledTimes(1);
  });

  it('service.stopped resolves after orchestrator.stop() resolves', async () => {
    let resolveOrchStop!: () => void;
    const orch: Orchestrator = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockReturnValue(new Promise<void>(r => { resolveOrchStop = r; })),
    };
    const service = new Service(makeConfig(), { orchestrator: orch });
    service.start();
    await new Promise(r => setTimeout(r, 50));

    let stoppedResolved = false;
    service.stopped.then(() => { stoppedResolved = true; });

    service.stop();
    await new Promise(r => setTimeout(r, 20));
    expect(stoppedResolved).toBe(false); // not yet, orchestrator hasn't finished

    resolveOrchStop();
    await new Promise(r => setTimeout(r, 20));
    expect(stoppedResolved).toBe(true);
  });

  it('service without orchestrator behaves identically to before', async () => {
    const log = captureLog();
    const service = new Service(makeConfig(), { logDestination: log.destination });
    service.start();
    await new Promise(r => setTimeout(r, 50));
    service.stop();
    await service.stopped;

    const events = log.entries.map(e => e.event);
    expect(events).toContain('service.ready');
    expect(events).toContain('service.stopped');
  });
});
