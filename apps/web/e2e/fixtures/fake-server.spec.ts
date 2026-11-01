/**
 * The fixture's own test: two fake servers run at once on different ports and
 * different state directories, and stopping one leaves the other answering
 * `/health`. This is a Node-only test (no browser), so it uses the base
 * Playwright `test` and drives `startFakeServer` directly.
 */
import { expect, test } from '@playwright/test';

import { startFakeServer } from './fake-server.js';

async function healthStatus(baseUrl: string): Promise<number> {
  const response = await fetch(`${baseUrl}/health`);
  return response.status;
}

test('two fake servers run independently and stop independently', async () => {
  const first = await startFakeServer();
  const second = await startFakeServer();
  try {
    // Different ports and different state directories.
    expect(first.baseUrl).not.toBe(second.baseUrl);
    expect(first.stateDir).not.toBe(second.stateDir);

    // Both answer /health.
    expect(await healthStatus(first.baseUrl)).toBe(200);
    expect(await healthStatus(second.baseUrl)).toBe(200);

    // Stopping one leaves the other answering.
    await first.stop();
    expect(await healthStatus(second.baseUrl)).toBe(200);
  } finally {
    await second.stop();
    await first.stop();
  }
});
