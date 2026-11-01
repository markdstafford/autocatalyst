/**
 * End-to-end coverage of the real connection flow against the built client served by
 * a fake-mode control plane.
 *
 * These drive `apps/web/dist` served from the control plane's own origin — no
 * `page.route`, no injected browser storage, no test-only hook. They cover the
 * no-token empty state, the wrong/right token outcomes, save/clear, the stored-token
 * label after reload, the token's absence from page text, and the footer health
 * indicator going offline, recovering, and surviving a control-plane restart without
 * re-entering the token.
 */
import { expect, test } from './fixtures/fake-server.js';

const FIXTURE_TOKEN = 'fake-mode-token';
const WRONG_TOKEN = 'not-the-token';
const REJECTED_FIX =
  'The control plane rejected the token. Check the bearer token the server was started with.';

async function visibleText(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(() => document.body.innerText);
}

test('connects, saves, and keeps the token out of page text', async ({ page, fakeServer }) => {
  await page.goto(`${fakeServer.baseUrl}/runs`);

  // No token stored: the connect empty state leads to Connection settings.
  await expect(page.getByRole('heading', { name: 'Connect to the control plane' })).toBeVisible();
  await page.getByRole('button', { name: 'Open connection settings' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Connection' })).toBeVisible();

  // Wrong token: Failed with the 401 fix text.
  await page.getByLabel('Bearer token').fill(WRONG_TOKEN);
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByText('Failed')).toBeVisible();
  await expect(page.getByText(REJECTED_FIX)).toBeVisible();
  expect(await visibleText(page)).not.toContain(WRONG_TOKEN);

  // Right token: Connected.
  await page.getByLabel('Bearer token').fill(FIXTURE_TOKEN);
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByText('Connected')).toBeVisible();
  expect(await visibleText(page)).not.toContain(FIXTURE_TOKEN);

  // Save: confirmation shows and the field clears.
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved')).toBeVisible();
  await expect(page.getByLabel(/Bearer token/)).toHaveValue('');

  // Reload: the stored-token label shows and the field is empty; the token never
  // appears in page text.
  await page.reload();
  await expect(
    page.getByLabel('Bearer token (leave blank to keep existing)')
  ).toHaveValue('');
  expect(await visibleText(page)).not.toContain(FIXTURE_TOKEN);

  // Runs no longer asks to connect; the main area is empty until #134.
  await page.goto(`${fakeServer.baseUrl}/runs`);
  await expect(page.getByRole('heading', { name: 'Connect to the control plane' })).toHaveCount(0);

  expect(await fakeServer.readLaunchCount()).toBe(0);
});

test('footer health: healthy, survives a restart without re-entry, and shows lost when the control plane is gone', async ({
  page,
  fakeServer
}) => {
  // Connect first so the shell is in the signed-in state.
  await page.goto(`${fakeServer.baseUrl}/settings/connection`);
  await page.getByLabel('Bearer token').fill(FIXTURE_TOKEN);
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByText('Connected')).toBeVisible();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved')).toBeVisible();

  // Healthy: no footer warning.
  await expect(page.getByText('Connection lost')).toHaveCount(0);

  // A real control-plane restart clears without re-entering the token: the stored
  // token persists and a focus-triggered health check reports healthy again. (Note:
  // the browser's own offline emulation does not block loopback requests, so the
  // "degraded/failed → Connection lost → recovery" transitions are proven
  // deterministically in the unit test `src/shell/health-indicator.spec.tsx`.)
  await fakeServer.restart();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByText('Connection lost')).toHaveCount(0);
  await page.goto(`${fakeServer.baseUrl}/runs`);
  await expect(page.getByRole('heading', { name: 'Connect to the control plane' })).toHaveCount(0);
  expect(await fakeServer.readLaunchCount()).toBe(0);

  // When the control plane is actually gone, the footer shows Connection lost.
  await fakeServer.stop();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByText('Connection lost')).toBeVisible();
});
