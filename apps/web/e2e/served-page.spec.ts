/**
 * End-to-end coverage of the real built shell served by the control plane in fake
 * mode.
 *
 * These tests drive the actual `apps/web/dist` build (the e2e target depends on
 * `web:build`) served from the control plane's own origin — no proxy, no CORS, no
 * `page.route`, no injected browser storage, and no test-only hook. They prove the
 * served build routes correctly, renders the shell with the connect empty state when
 * no token is stored, loads only from the control plane's own origin, applies the
 * first-paint theme, and never triggers a model call (the scripted-launch counter
 * stays `0`). The full connection flow is in `connection.spec.ts`.
 */
import { expect, test } from './fixtures/fake-server.js';

const ENTRY_CHUNK = /\/assets\/index-[^/]+\.js$/;
const DARK_THEMES = [
  'catppuccin-frappe',
  'catppuccin-macchiato',
  'catppuccin-mocha',
  'github-dark',
  'dracula'
];

test('serves the built shell and loads only from the same origin', async ({ page, fakeServer }) => {
  const origin = new URL(fakeServer.baseUrl).origin;
  const requestedOrigins = new Set<string>();
  const requestedUrls: string[] = [];
  page.on('request', (request) => {
    requestedOrigins.add(new URL(request.url()).origin);
    requestedUrls.push(request.url());
  });

  await page.goto(`${fakeServer.baseUrl}/`);

  // `/` redirects to `/runs`; with no token stored the shell shows the connect
  // empty state and the persistent footer.
  await expect(page.getByRole('heading', { name: 'Connect to the control plane' })).toBeVisible();
  await expect(page.getByRole('contentinfo')).toBeVisible();

  // The entry chunk loaded on page load.
  expect(requestedUrls.some((url) => ENTRY_CHUNK.test(url))).toBe(true);

  // Everything came from the control plane's own origin.
  expect([...requestedOrigins]).toEqual([origin]);

  // No model call happened: the scripted-launch counter is zero after the test.
  expect(await fakeServer.readLaunchCount()).toBe(0);
});

test('serves /runs and the not-found page on direct loads', async ({ page, fakeServer }) => {
  await page.goto(`${fakeServer.baseUrl}/runs`);
  await expect(page.getByRole('heading', { level: 1, name: 'Runs' })).toBeVisible();

  await page.goto(`${fakeServer.baseUrl}/not-a-route`);
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();

  // The not-found page links back to /runs and navigation renders the shell.
  await page.getByRole('link', { name: 'Back to runs' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Runs' })).toBeVisible();

  expect(await fakeServer.readLaunchCount()).toBe(0);
});

test('applies a dark theme before mount under an emulated dark system preference', async ({
  page,
  fakeServer
}) => {
  await page.emulateMedia({ colorScheme: 'dark' });

  await page.goto(`${fakeServer.baseUrl}/`);
  await expect(page.getByRole('heading', { level: 1, name: 'Runs' })).toBeVisible();

  // No storage was injected, so the first-paint script resolves the system scheme
  // to the default dark theme slot.
  const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  const mode = await page.evaluate(() => document.documentElement.getAttribute('data-theme-mode'));
  expect(mode).toBe('dark');
  expect(DARK_THEMES).toContain(theme);

  expect(await fakeServer.readLaunchCount()).toBe(0);
});

test('restart keeps serving the shell after a reload', async ({ page, fakeServer }) => {
  await page.goto(`${fakeServer.baseUrl}/`);
  await expect(page.getByRole('heading', { level: 1, name: 'Runs' })).toBeVisible();

  await fakeServer.restart();

  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Runs' })).toBeVisible();

  expect(await fakeServer.readLaunchCount()).toBe(0);
});
