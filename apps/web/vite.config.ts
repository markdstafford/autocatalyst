/// <reference types="vitest" />
import { resolve } from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

import { sharedTestPool } from '../../vitest.shared';
import { nodeImportGuard } from './vite/node-import-guard';

/**
 * Vite configuration for the `web` client.
 *
 * `@autocatalyst/sdk` and `@autocatalyst/api-contract` resolve to source (not
 * built package output) so the browser bundle is checked at the source level and
 * the Node-import guard can see everything that ships to the client. The control
 * plane resolves the SDK through its package output; the browser build needs the
 * source alias instead.
 */
export default defineConfig({
  cacheDir: '../../node_modules/.vite/apps/web',
  plugins: [react(), tailwindcss(), nodeImportGuard()],
  resolve: {
    alias: {
      '@autocatalyst/sdk': resolve(__dirname, '../../packages/sdk/src/index.ts'),
      '@autocatalyst/api-contract': resolve(__dirname, '../../packages/api-contract/src/index.ts')
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    manifest: true,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]'
      }
    }
  },
  test: {
    ...sharedTestPool,
    environment: 'jsdom',
    globals: false,
    setupFiles: ['src/test-setup.ts'],
    include: ['src/**/*.spec.ts', 'src/**/*.spec.tsx', 'vite/**/*.spec.ts'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../coverage/apps/web'
    }
  }
});
