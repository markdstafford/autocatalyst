import { resolve } from 'node:path';

import { defineConfig } from 'vite';

export default defineConfig({
  cacheDir: '../../node_modules/.vite/packages/sdk',
  resolve: {
    alias: {
      '@autocatalyst/api-contract': resolve(__dirname, '../api-contract/src/index.ts'),
      '@autocatalyst/core': resolve(__dirname, '../core/src/index.ts')
    }
  },
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.spec.ts'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../coverage/packages/sdk'
    }
  }
});
