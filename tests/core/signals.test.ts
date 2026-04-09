import { describe, it, expect } from 'vitest';
import { registerSignalHandlers } from '../../src/core/signals.js';
import { Service } from '../../src/core/service.js';
import type { LoadedConfig } from '../../src/types/config.js';

function makeConfig(): LoadedConfig {
  return {
    config: { polling: { interval_ms: 100 } },
    promptTemplate: 'test',
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

describe('registerSignalHandlers', () => {
  it('returns a cleanup function', () => {
    const log = captureLog();
    const service = new Service(makeConfig(), { logDestination: log.destination });
    const cleanup = registerSignalHandlers(service);
    expect(typeof cleanup).toBe('function');
    cleanup();
  });
});
