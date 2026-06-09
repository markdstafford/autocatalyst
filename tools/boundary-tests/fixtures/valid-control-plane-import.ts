import type { Runner, RunnerRunInput } from '@autocatalyst/execution';

export const validControlPlaneRunner: Runner = {
  async *run(_input: RunnerRunInput) {
    // new streaming contract
  },
  async close() {
    return { status: 'closed' as const };
  }
};
