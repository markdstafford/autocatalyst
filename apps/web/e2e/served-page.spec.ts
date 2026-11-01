/**
 * Proves a real browser loads the fixture client from the control plane's own
 * origin and reads the API from that same origin — no proxy, no CORS, no
 * test-only route. The client does not exist yet; #131 replaces the fixture with
 * the real build and keeps this test.
 */
import { expect, test } from './fixtures/fake-server.js';

const HASHED_SCRIPT = '/assets/health-probe.a1b2c3d4e5.js';

test('serves the fixture client and reads health from the same origin', async ({
  page,
  fakeServer
}) => {
  const origin = new URL(fakeServer.baseUrl).origin;
  const requestedOrigins = new Set<string>();
  const responses: Array<{ url: string; status: number }> = [];
  page.on('request', (request) => {
    requestedOrigins.add(new URL(request.url()).origin);
  });
  page.on('response', (response) => {
    responses.push({ url: response.url(), status: response.status() });
  });

  await page.goto(`${fakeServer.baseUrl}/`);

  // The page loaded from the control plane's own origin.
  await expect(page.getByRole('heading', { name: 'Autocatalyst fixture client' })).toBeVisible();

  // The client fetched /health from its own origin and printed the status.
  await expect(page.getByLabel('health status')).toHaveText('health: ok');

  // The hashed script loaded with status 200 from the same origin as the page.
  const scriptResponse = responses.find((entry) => entry.url === `${origin}${HASHED_SCRIPT}`);
  expect(scriptResponse, 'the hashed script was requested').toBeDefined();
  expect(scriptResponse?.status).toBe(200);

  // The browser sent no request to any other origin.
  expect([...requestedOrigins]).toEqual([origin]);

  // No model call happened: the scripted-launch counter is zero after the test.
  expect(await fakeServer.readLaunchCount()).toBe(0);
});

test('restart keeps serving health after a reload', async ({ page, fakeServer }) => {
  await page.goto(`${fakeServer.baseUrl}/`);
  await expect(page.getByLabel('health status')).toHaveText('health: ok');

  await fakeServer.restart();

  await page.reload();
  await expect(page.getByLabel('health status')).toHaveText('health: ok');

  expect(await fakeServer.readLaunchCount()).toBe(0);
});
