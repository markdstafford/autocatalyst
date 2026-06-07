import { defineConfig } from 'vite';

export default defineConfig({
  cacheDir: '../../node_modules/.vite/packages/persistence',
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.spec.ts'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../coverage/packages/persistence'
    }
  }
});
