/**
 * End-to-end coverage of the real connection flow against the built client served by
 * a fake-mode control plane.
 *
 * These drive `apps/web/dist` served from the control plane's own origin — no
 * `page.route`, no injected browser storage, no test-only hook. They cover the
 * no-token empty state, the apply-on-commit wrong/right token outcomes committed with
 * `Enter` (no Test/Save controls), returning to Runs with Back, the stored-token label
 * after reload, the token's absence from page text, and the footer health indicator
 * going offline, recovering, and surviving a control-plane restart without re-entering
 * the token.
 */
import { expect, test } from './fixtures/fake-server.js';

const FIXTURE_TOKEN = 'fake-mode-token';
const WRONG_TOKEN = 'not-the-token';
const REJECTED_FIX =
  'The control plane rejected the token. Check the bearer token the server was started with.';

async function visibleText(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(() => document.body.innerText);
}

test('applies a token on commit and keeps the token out of page text', async ({
  page,
  fakeServer
}) => {
  await page.goto(`${fakeServer.baseUrl}/runs`);

  // No token stored: the connect empty state leads to Connection settings.
  await expect(page.getByRole('heading', { name: 'Connect to the control plane' })).toBeVisible();
  await page.getByRole('button', { name: 'Open connection settings' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Connection' })).toBeVisible();

  // Wrong token committed with Enter: Failed with the 401 fix text; nothing is stored
  // and the typed value stays for correction.
  await page.getByLabel('Bearer token').fill(WRONG_TOKEN);
  await page.getByLabel('Bearer token').press('Enter');
  await expect(page.getByText('Failed')).toBeVisible();
  await expect(page.getByText(REJECTED_FIX)).toBeVisible();
  expect(await visibleText(page)).not.toContain(WRONG_TOKEN);

  // Right token committed with Enter: Connected, the token is stored, and the field
  // clears (no separate Save step).
  await page.getByLabel('Bearer token').fill(FIXTURE_TOKEN);
  await page.getByLabel('Bearer token').press('Enter');
  await expect(page.getByText('Connected')).toBeVisible();
  await expect(page.getByLabel(/Bearer token/)).toHaveValue('');
  expect(await visibleText(page)).not.toContain(FIXTURE_TOKEN);

  // Back returns to Runs, which no longer asks to connect: the run list works.
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Runs' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Connect to the control plane' })).toHaveCount(0);

  // Reload the Connection page: the stored-token label shows and the field is empty;
  // the token never appears in page text.
  await page.goto(`${fakeServer.baseUrl}/settings/connection`);
  await expect(
    page.getByLabel('Bearer token (leave blank to keep existing)')
  ).toHaveValue('');
  expect(await visibleText(page)).not.toContain(FIXTURE_TOKEN);

  expect(await fakeServer.readLaunchCount()).toBe(0);
});

test('footer health: offline shows Connection lost, online clears it, and a restart recovers without re-entering the token', async ({
  page,
  fakeServer
}) => {
  const STORED_LABEL = 'Bearer token (leave blank to keep existing)';

  // Connect first so the shell is in the signed-in state.
  await page.goto(`${fakeServer.baseUrl}/settings/connection`);
  await page.getByLabel('Bearer token').fill(FIXTURE_TOKEN);
  await page.getByLabel('Bearer token').press('Enter');
  await expect(page.getByText('Connected')).toBeVisible();

  // Healthy: no footer warning.
  await expect(page.getByText('Connection lost')).toHaveCount(0);

  // Offline: the control plane stops answering. The footer's periodic health poll
  // (every 5 s) detects the outage and shows "Connection lost" — no focus nudge, so
  // this proves the interval, not just the focus-triggered check. The stored token is
  // untouched the whole time.
  await fakeServer.goOffline();
  await expect(page.getByText('Connection lost')).toBeVisible({ timeout: 15_000 });

  // Online: the control plane answers again. A focus-triggered health check clears the
  // indicator without the operator ever re-entering the token, and the stored-token
  // label still shows an empty field.
  await fakeServer.goOnline();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByText('Connection lost')).toHaveCount(0);
  await expect(page.getByLabel(STORED_LABEL)).toHaveValue('');
  expect(await fakeServer.readLaunchCount()).toBe(0);

  // A full control-plane restart likewise clears without re-entering the token: the
  // stored token persists and a focus-triggered health check reports healthy again.
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
