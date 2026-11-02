/**
 * Run list and selection end-to-end coverage against fake mode on the production path.
 *
 * Each test opens the built client served by its own fake control plane, authenticated
 * through the connected storage-state fixture (which drives the real Connection page —
 * no injected token). Scenarios are seeded through the SDK-backed seed entry, never by
 * writing browser storage or routing around the API, and no test makes a model call.
 */
import { expect, test } from './fixtures/connected.js';
import type { Browser, Page } from '@playwright/test';

const EDGE = 0.5;

/** Open a connected context at the given runs path and return the page + its context. */
async function openRuns(
  browser: Browser,
  connectedStatePath: string,
  url: string
): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ storageState: connectedStatePath });
  const page = await context.newPage();
  await page.goto(url);
  return { page, close: () => context.close() };
}

function dataRows(page: Page) {
  return page.locator('[role="row"][data-run-id]');
}

function selectedRow(page: Page) {
  return page.locator('[role="row"][aria-selected="true"]');
}

test.describe('run list', () => {
  test('shows every seeded run with exactly one selection and keyboard navigation', async ({
    browser,
    fakeServer,
    connectedStatePath
  }) => {
    for (const scenario of ['spec-review', 'implementation-review', 'pr-open', 'merged', 'failed']) {
      await fakeServer.seed({ scenario });
    }

    const { page, close } = await openRuns(browser, connectedStatePath, `${fakeServer.baseUrl}/runs`);
    try {
      await expect(page.getByRole('grid', { name: 'Runs' })).toBeVisible();
      await expect(dataRows(page)).toHaveCount(5);

      // Exactly one selected row, and the address reflects it.
      await expect(selectedRow(page)).toHaveCount(1);
      const firstId = await selectedRow(page).getAttribute('data-run-id');
      expect(firstId).not.toBeNull();
      await expect(page).toHaveURL(new RegExp(`/runs/${firstId}$`));

      // The pane reflects the selected run.
      await expect(page.getByTestId('pane-run-id')).toHaveText(firstId ?? '');

      // Focus the list via a row click, then move with the keyboard.
      await page.locator(`[data-run-id="${firstId}"]`).click();
      await page.keyboard.press('j');
      await expect(selectedRow(page)).toHaveCount(1);
      const secondId = await selectedRow(page).getAttribute('data-run-id');
      expect(secondId).not.toBe(firstId);
      await expect(page).toHaveURL(new RegExp(`/runs/${secondId}$`));
      await expect(page.getByTestId('pane-run-id')).toHaveText(secondId ?? '');

      // ArrowDown moves on; ArrowUp and k move back.
      await page.keyboard.press('ArrowDown');
      const thirdId = await selectedRow(page).getAttribute('data-run-id');
      expect(thirdId).not.toBe(secondId);
      await page.keyboard.press('k');
      await expect(selectedRow(page)).toHaveAttribute('data-run-id', secondId ?? '');
      await page.keyboard.press('ArrowUp');
      await expect(selectedRow(page)).toHaveAttribute('data-run-id', firstId ?? '');
    } finally {
      await close();
    }
  });

  test('reloading /runs/:runId preserves the selected run', async ({
    browser,
    fakeServer,
    connectedStatePath
  }) => {
    for (const scenario of ['spec-review', 'implementation-review', 'pr-open']) {
      await fakeServer.seed({ scenario });
    }
    const { page, close } = await openRuns(browser, connectedStatePath, `${fakeServer.baseUrl}/runs`);
    try {
      await expect(dataRows(page)).toHaveCount(3);
      // Select the second row and remember its id.
      const first = await selectedRow(page).getAttribute('data-run-id');
      await page.locator(`[data-run-id="${first}"]`).click();
      await page.keyboard.press('j');
      const selectedId = await selectedRow(page).getAttribute('data-run-id');

      await page.reload();
      await expect(selectedRow(page)).toHaveAttribute('data-run-id', selectedId ?? '');
      await expect(page).toHaveURL(new RegExp(`/runs/${selectedId}$`));
    } finally {
      await close();
    }
  });

  test('a run seeded while the page is open appears after a poll', async ({
    browser,
    fakeServer,
    connectedStatePath
  }) => {
    await fakeServer.seed({ scenario: 'spec-review' });
    const { page, close } = await openRuns(browser, connectedStatePath, `${fakeServer.baseUrl}/runs`);
    try {
      await expect(dataRows(page)).toHaveCount(1);
      await fakeServer.seed({ scenario: 'merged' });
      // Polling is every 5s; allow a margin.
      await expect(dataRows(page)).toHaveCount(2, { timeout: 15_000 });
    } finally {
      await close();
    }
  });

  test('an empty server shows the no-runs state without a Start a run button', async ({
    browser,
    fakeServer,
    connectedStatePath
  }) => {
    const { page, close } = await openRuns(browser, connectedStatePath, `${fakeServer.baseUrl}/runs`);
    try {
      await expect(page.getByTestId('runs-empty-no-runs')).toBeVisible();
      await expect(page.getByText('A run starts from a tracked issue.')).toBeVisible();
      await expect(page.getByRole('button', { name: /start a run/i })).toHaveCount(0);
    } finally {
      await close();
    }
  });
});

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`run list geometry (${scheme})`, () => {
    test.use({ colorScheme: scheme });

    test('pane, handle, and footer detail-pane zone align with the list', async ({
      browser,
      fakeServer,
      connectedStatePath
    }) => {
      await fakeServer.seed({ scenario: 'spec-review' });
      await fakeServer.seed({ scenario: 'merged' });
      const { page, close } = await openRuns(browser, connectedStatePath, `${fakeServer.baseUrl}/runs`);
      try {
        await expect(dataRows(page)).toHaveCount(2);

        const header = await page.getByTestId('run-table-header').boundingBox();
        const paneBar = await page.getByTestId('pane-bar').boundingBox();
        const pane = await page.getByRole('complementary', { name: 'Run detail' }).boundingBox();
        const handle = await page.getByRole('separator').boundingBox();
        const paneZone = await page.getByRole('group', { name: 'Detail pane' }).boundingBox();
        expect(header).not.toBeNull();
        expect(paneBar).not.toBeNull();
        expect(pane).not.toBeNull();
        expect(handle).not.toBeNull();
        expect(paneZone).not.toBeNull();
        if (header && paneBar && pane && handle && paneZone) {
          // Pane bar top equals the table column header top; heights match.
          expect(Math.abs(paneBar.y - header.y)).toBeLessThanOrEqual(EDGE);
          expect(Math.abs(paneBar.height - header.height)).toBeLessThanOrEqual(EDGE);
          // The handle sits immediately left of the pane.
          expect(Math.abs(handle.x + handle.width - pane.x)).toBeLessThanOrEqual(EDGE);
          // The footer detail-pane zone's left edge equals the pane's left edge.
          expect(Math.abs(paneZone.x - pane.x)).toBeLessThanOrEqual(EDGE);
        }

        // Hiding the pane collapses the footer detail-pane zone to zero width. The
        // zone animates its width (`--duration-layout`), so let the transition settle
        // before measuring.
        await page.locator('body').press(']');
        await expect(page.getByRole('complementary', { name: 'Run detail' })).toHaveCount(0);
        await page.waitForTimeout(400);
        const hiddenZone = await page.getByRole('group', { name: 'Detail pane' }).boundingBox();
        expect(hiddenZone).not.toBeNull();
        if (hiddenZone) {
          expect(hiddenZone.width).toBeLessThanOrEqual(EDGE);
        }
      } finally {
        await close();
      }
    });
  });
}
