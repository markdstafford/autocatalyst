import { describe, expect, it, vi } from 'vitest';
import { CommandRegistryImpl } from '../../../src/core/command-registry.js';
import { registerDefaultCommands } from '../../../src/core/commands/registry-setup.js';

describe('registerDefaultCommands', () => {
  it('registers the built-in run, health, help, and classify commands', () => {
    const registry = new CommandRegistryImpl();

    registerDefaultCommands(registry, {
      runs: new Map(),
      cancelRun: vi.fn(),
      getRunLogs: vi.fn().mockReturnValue([]),
      isConnected: vi.fn().mockReturnValue(true),
      getActiveRunCount: vi.fn().mockReturnValue(0),
      intentClassifier: { classify: vi.fn().mockResolvedValue('idea') },
    });

    expect(registry.list()).toEqual(expect.arrayContaining([
      'run.status',
      'run.list',
      'run.cancel',
      'run.logs',
      'health',
      'help',
      'classify-intent',
    ]));
  });
});
