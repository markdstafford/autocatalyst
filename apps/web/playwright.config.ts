import { defineConfig } from '@playwright/test';

/**
 * Playwright configuration for the `web` project's end-to-end tests.
 *
 * There is no `webServer` entry: each spec file provisions its own control
 * plane in fake mode through the `fake-server` fixture (see
 * `e2e/fixtures/fake-server.ts`). A per-spec server keeps scenarios, pull
 * request state and forced failures isolated between spec files.
 *
 * The run is deterministic: one Chromium project, no parallelism, a single
 * worker and no retries, so a flake surfaces as a failure rather than being
 * retried away.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' }
    }
  ]
});
