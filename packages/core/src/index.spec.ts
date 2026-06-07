import { describe, expect, it } from 'vitest';

import { createCoreScaffold } from './index.js';
import type { Runner } from '@autocatalyst/execution';

describe('core scaffold', () => {
  it('depends on the execution public Runner boundary only', () => {
    const runner: Runner = {
      async run(input) {
        return { runId: input.runId, status: 'accepted' };
      }
    };

    expect(createCoreScaffold(runner)).toEqual({
      packageName: '@autocatalyst/core',
      acceptsRunnerBoundary: true
    });
  });
});
