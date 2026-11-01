/**
 * End-to-end coverage of the real built foundation page served by the control
 * plane in fake mode.
 *
 * These tests drive the actual `apps/web/dist` build (the e2e target depends on
 * `web:build`) served from the control plane's own origin — no proxy, no CORS, no
 * `page.route`, no injected browser storage, and no test-only hook. They prove the
 * served build routes correctly, reads `/health` through the SDK from the same
 * origin, lazily loads Shiki only when the operator asks, and never triggers a
 * model call (the scripted-launch counter stays `0`).
 */
import { expect, test } from './fixtures/fake-server.js';

const ENTRY_CHUNK = /\/assets\/index-[^/]+\.js$/;
const SHIKI_CHUNK = /\/assets\/(core|engine-javascript|json|github-light|github-dark)-[^/]+\.js$/;
const DARK_THEMES = [
  'catppuccin-frappe',
  'catppuccin-macchiato',
  'catppuccin-mocha',
  'github-dark',
  'dracula'
];

test('serves the built foundation page and reads health from the same origin', async ({
  page,
  fakeServer
}) => {
  const origin = new URL(fakeServer.baseUrl).origin;
  const requestedOrigins = new Set<string>();
  const requestedUrls: string[] = [];
  page.on('request', (request) => {
    requestedOrigins.add(new URL(request.url()).origin);
    requestedUrls.push(request.url());
  });

  await page.goto(`${fakeServer.baseUrl}/`);

  // `/` redirects to `/runs` and the foundation page renders from the built app.
  await expect(page.getByRole('heading', { name: 'Autocatalyst' })).toBeVisible();

  // The entry chunk loaded on page load; the Shiki chunks did not (lazy).
  expect(requestedUrls.some((url) => ENTRY_CHUNK.test(url))).toBe(true);
  expect(requestedUrls.some((url) => SHIKI_CHUNK.test(url))).toBe(false);

  // Clicking the connection button calls /health through the SDK and renders the
  // highlighted response — which pulls in the Shiki chunk for the first time.
  await page.getByRole('button', { name: 'Check connection' }).click();
  await expect(page.getByLabel('health response')).toContainText('"status": "ok"');
  expect(requestedUrls.some((url) => SHIKI_CHUNK.test(url))).toBe(true);

  // Everything came from the control plane's own origin.
  expect([...requestedOrigins]).toEqual([origin]);

  // No model call happened: the scripted-launch counter is zero after the test.
  expect(await fakeServer.readLaunchCount()).toBe(0);
});

test('serves /runs and the not-found page on direct loads', async ({ page, fakeServer }) => {
  await page.goto(`${fakeServer.baseUrl}/runs`);
  await expect(page.getByRole('heading', { name: 'Autocatalyst' })).toBeVisible();

  await page.goto(`${fakeServer.baseUrl}/not-a-route`);
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();

  // The not-found page links back to /runs and navigation renders the foundation page.
  await page.getByRole('link', { name: 'Back to runs' }).click();
  await expect(page.getByRole('heading', { name: 'Autocatalyst' })).toBeVisible();

  expect(await fakeServer.readLaunchCount()).toBe(0);
});

test('applies a dark theme before mount under an emulated dark system preference', async ({
  page,
  fakeServer
}) => {
  await page.emulateMedia({ colorScheme: 'dark' });

  await page.goto(`${fakeServer.baseUrl}/`);
  await expect(page.getByRole('heading', { name: 'Autocatalyst' })).toBeVisible();

  // No storage was injected, so the first-paint script resolves the system scheme
  // to the default dark theme slot.
  const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  const mode = await page.evaluate(() => document.documentElement.getAttribute('data-theme-mode'));
  expect(mode).toBe('dark');
  expect(DARK_THEMES).toContain(theme);

  expect(await fakeServer.readLaunchCount()).toBe(0);
});

test('restart keeps serving the foundation page after a reload', async ({ page, fakeServer }) => {
  await page.goto(`${fakeServer.baseUrl}/`);
  await expect(page.getByRole('heading', { name: 'Autocatalyst' })).toBeVisible();

  await fakeServer.restart();

  await page.reload();
  await page.getByRole('button', { name: 'Check connection' }).click();
  await expect(page.getByLabel('health response')).toContainText('"status": "ok"');

  expect(await fakeServer.readLaunchCount()).toBe(0);
});
