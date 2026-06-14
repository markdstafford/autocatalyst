import { resolve } from 'node:path';
import { defineConfig } from 'vite';

import { sharedTestPool } from '../../vitest.shared';

export default defineConfig({
  cacheDir: '../../node_modules/.vite/packages/execution',
  resolve: {
    alias: {
      '@autocatalyst/api-contract': resolve(__dirname, '../api-contract/src/index.ts')
    }
  },
  test: {
    ...sharedTestPool,
    environment: 'node',
    globals: false,
    include: ['src/**/*.spec.ts'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../coverage/packages/execution'
    }
  }
});
