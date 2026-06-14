import { defineConfig } from 'vite';

import { sharedTestPool } from '../../vitest.shared';

export default defineConfig({
  cacheDir: '../../node_modules/.vite/packages/api-contract',
  test: {
    ...sharedTestPool,
    environment: 'node',
    globals: false,
    include: ['src/**/*.spec.ts'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../coverage/packages/api-contract'
    }
  }
});
