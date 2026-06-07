import { describe, expect, it } from 'vitest';

import { createSdkScaffold } from './index.js';

describe('sdk scaffold', () => {
  it('uses the shared api-contract type', () => {
    expect(createSdkScaffold()).toEqual({
      packageName: '@autocatalyst/sdk',
      exampleHealthResponse: { status: 'ok' }
    });
  });
});
