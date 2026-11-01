/**
 * Proves the connected storage-state fixture: a context created from the saved state
 * (produced by driving the real Connection page) opens Runs already connected, with no
 * connect prompt — and no spec writes browser storage directly.
 */
import { expect, test } from './fixtures/connected.js';

test('a context from connected state opens Runs already connected', async ({
  browser,
  fakeServer,
  connectedStatePath
}) => {
  const context = await browser.newContext({ storageState: connectedStatePath });
  const page = await context.newPage();
  try {
    await page.goto(`${fakeServer.baseUrl}/runs`);
    await expect(page.getByRole('heading', { level: 1, name: 'Runs' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Connect to the control plane' })).toHaveCount(0);
    expect(await fakeServer.readLaunchCount()).toBe(0);
  } finally {
    await context.close();
  }
});
