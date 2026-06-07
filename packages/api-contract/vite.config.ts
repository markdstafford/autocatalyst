import { defineConfig } from 'vite';

export default defineConfig({
  cacheDir: '../../node_modules/.vite/packages/api-contract',
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.spec.ts'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../coverage/packages/api-contract'
    }
  }
});
