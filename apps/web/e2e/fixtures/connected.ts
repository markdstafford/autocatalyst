/**
 * Connected storage-state fixture.
 *
 * The only sanctioned way for a spec to obtain an authenticated client is to drive
 * the *real* Connection page once per fake server: enter the fixture token and commit
 * it with `Enter` (apply-on-commit stores it on a successful check), then capture the
 * resulting browser storage state to a file in a temporary directory. Other specs then
 * create contexts from that state (`storageState`) and never write browser storage
 * themselves — no `page.route`, no injected token, no test-only hook.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test as fakeServerTest, expect } from './fake-server.js';

/** The bearer token the fake-mode control plane accepts on `/v1` routes. */
export const FIXTURE_TOKEN = 'fake-mode-token';

export interface ConnectedFixtures {
  /** Absolute path to a Playwright storage-state file with the token saved. */
  readonly connectedStatePath: string;
}

export const test = fakeServerTest.extend<ConnectedFixtures>({
  connectedStatePath: async ({ browser, fakeServer }, use) => {
    const dir = await mkdtemp(join(tmpdir(), 'autocatalyst-web-connected-'));
    const statePath = join(dir, 'state.json');

    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${fakeServer.baseUrl}/settings/connection`);

    await page.getByLabel('Bearer token').fill(FIXTURE_TOKEN);
    await page.getByLabel('Bearer token').press('Enter');
    await expect(page.getByText('Connected')).toBeVisible();
    // Apply-on-commit stores the token on success and clears the field.
    await expect(page.getByLabel(/Bearer token/)).toHaveValue('');

    await context.storageState({ path: statePath });
    await context.close();

    await use(statePath);
  }
});

export { expect };
