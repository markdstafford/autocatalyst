import { resolve } from 'node:path';
import { defineConfig } from 'vite';

import { sharedTestPool } from '../../vitest.shared';

export default defineConfig({
  cacheDir: '../../node_modules/.vite/packages/github-code-host-adapter',
  resolve: {
    alias: {
      '@autocatalyst/core': resolve(__dirname, '../core/src/index.ts'),
      '@autocatalyst/github-issue-tracker-adapter': resolve(__dirname, '../github-issue-tracker-adapter/src/index.ts')
    }
  },
  test: {
    ...sharedTestPool,
    environment: 'node',
    globals: false,
    include: ['src/**/*.spec.ts'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../coverage/packages/github-code-host-adapter'
    }
  }
});
