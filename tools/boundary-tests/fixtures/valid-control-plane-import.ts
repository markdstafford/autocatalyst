import type { Runner, RunnerRunInput } from '@autocatalyst/execution';

export const validControlPlaneRunner: Runner = {
  async *run(_input: RunnerRunInput) {
    // new streaming contract
  },
  async close() {
    return { status: 'closed' as const };
  }
};

// Deliberate CI execution-boundary violation for issue #109; never merge this branch.
import '@autocatalyst/execution/src/index';
