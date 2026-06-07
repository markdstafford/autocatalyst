import type { Runner } from '@autocatalyst/execution';

export interface CoreScaffold {
  readonly packageName: '@autocatalyst/core';
  readonly acceptsRunnerBoundary: true;
}

export function createCoreScaffold(_runner: Runner): CoreScaffold {
  return {
    packageName: '@autocatalyst/core',
    acceptsRunnerBoundary: true
  };
}
