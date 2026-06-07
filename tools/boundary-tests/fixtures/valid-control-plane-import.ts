import type { Runner } from '@autocatalyst/execution';

export const validControlPlaneRunner: Runner = {
  async run(input) {
    return { runId: input.runId, status: 'accepted' };
  }
};
