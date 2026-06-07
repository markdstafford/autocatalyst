import { describe, expect, it } from 'vitest';

import { executionPackageName, type Runner } from './index.js';

describe('execution scaffold', () => {
  it('exposes the public Runner boundary', async () => {
    const runner: Runner = {
      async run(input) {
        return { runId: input.runId, status: 'accepted' };
      }
    };

    await expect(runner.run({ runId: 'run_123' })).resolves.toEqual({
      runId: 'run_123',
      status: 'accepted'
    });
    expect(executionPackageName).toBe('@autocatalyst/execution');
  });
});
