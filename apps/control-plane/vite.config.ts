import { resolve } from 'node:path';

import { defineConfig } from 'vite';

import { sharedTestPool } from '../../vitest.shared';

export default defineConfig({
  cacheDir: '../../node_modules/.vite/apps/control-plane',
  resolve: {
    alias: {
      '@autocatalyst/api-contract': resolve(__dirname, '../../packages/api-contract/src/index.ts'),
      '@autocatalyst/anthropic-direct-adapter': resolve(__dirname, '../../packages/anthropic-direct-adapter/src/index.ts'),
      '@autocatalyst/claude-agent-adapter': resolve(__dirname, '../../packages/claude-agent-adapter/src/index.ts'),
      '@autocatalyst/core': resolve(__dirname, '../../packages/core/src/index.ts'),
      '@autocatalyst/execution': resolve(__dirname, '../../packages/execution/src/index.ts'),
      '@autocatalyst/openai-agent-adapter': resolve(__dirname, '../../packages/openai-agent-adapter/src/index.ts'),
      '@autocatalyst/openai-direct-adapter': resolve(__dirname, '../../packages/openai-direct-adapter/src/index.ts'),
      '@autocatalyst/persistence': resolve(__dirname, '../../packages/persistence/src/index.ts')
    }
  },
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.spec.ts'],
    reporters: ['default'],
    ...sharedTestPool,
    coverage: {
      reportsDirectory: '../../coverage/apps/control-plane'
    }
  }
});
