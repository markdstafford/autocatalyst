import type { HealthResponse } from '@autocatalyst/api-contract';

export interface SdkScaffold {
  readonly packageName: '@autocatalyst/sdk';
  readonly exampleHealthResponse: HealthResponse;
}

export function createSdkScaffold(): SdkScaffold {
  return {
    packageName: '@autocatalyst/sdk',
    exampleHealthResponse: { status: 'ok' }
  };
}
