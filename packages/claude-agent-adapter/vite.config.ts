import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  cacheDir: '../../node_modules/.vite/packages/claude-agent-adapter',
  resolve: {
    alias: {
      '@autocatalyst/api-contract': resolve(__dirname, '../api-contract/src/index.ts'),
      '@autocatalyst/execution': resolve(__dirname, '../execution/src/index.ts')
    }
  },
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.spec.ts'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../coverage/packages/claude-agent-adapter'
    }
  }
});
