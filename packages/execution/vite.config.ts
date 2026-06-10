import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  cacheDir: '../../node_modules/.vite/packages/execution',
  resolve: {
    alias: {
      '@autocatalyst/api-contract': resolve(__dirname, '../api-contract/src/index.ts')
    }
  },
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.spec.ts'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../coverage/packages/execution'
    }
  }
});
