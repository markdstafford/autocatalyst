import { resolve } from 'node:path';

import { defineConfig } from 'vite';

export default defineConfig({
  cacheDir: '../../node_modules/.vite/apps/control-plane',
  resolve: {
    alias: {
      '@autocatalyst/api-contract': resolve(__dirname, '../../packages/api-contract/src/index.ts'),
      '@autocatalyst/core': resolve(__dirname, '../../packages/core/src/index.ts'),
      '@autocatalyst/persistence': resolve(__dirname, '../../packages/persistence/src/index.ts')
    }
  },
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.spec.ts'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../coverage/apps/control-plane'
    }
  }
});
