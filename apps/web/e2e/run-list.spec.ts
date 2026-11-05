/**
 * Run list and selection end-to-end coverage against fake mode on the production path.
 *
 * Each test opens the built client served by its own fake control plane, authenticated
 * through the connected storage-state fixture (which drives the real Connection page —
 * no injected token). Scenarios are seeded through the SDK-backed seed entry, never by
 * writing browser storage or routing around the API, and no test makes a model call.
 */
import { expect, test } from './fixtures/connected.js';
import type { Browser, BrowserContextOptions, Page } from '@playwright/test';

const EDGE = 0.5;

/** Open a connected context at the given runs path and return the page + its context. */
async function openRuns(
  browser: Browser,
  connectedStatePath: string,
  url: string,
  contextOptions: BrowserContextOptions = {}
): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ storageState: connectedStatePath, ...contextOptions });
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
      await expect(page.getByRole('complementary', { name: 'Run detail' })).toHaveAttribute(
        'data-pane-run-id',
        firstId ?? ''
      );

      // Focus the list via a row click, then move with the keyboard.
      await page.locator(`[data-run-id="${firstId}"]`).click();
      await page.keyboard.press('j');
      await expect(selectedRow(page)).toHaveCount(1);
      const secondId = await selectedRow(page).getAttribute('data-run-id');
      expect(secondId).not.toBe(firstId);
      await expect(page).toHaveURL(new RegExp(`/runs/${secondId}$`));
      await expect(page.getByRole('complementary', { name: 'Run detail' })).toHaveAttribute(
        'data-pane-run-id',
        secondId ?? ''
      );

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

  test('pressing j through every run sends no cursor request when there is no next page', async ({
    browser,
    fakeServer,
    connectedStatePath
  }) => {
    const scenarios = ['spec-review', 'implementation-review', 'pr-open', 'merged', 'failed'];
    for (const scenario of scenarios) {
      await fakeServer.seed({ scenario });
    }

    // All five runs fit in one page (page size 50), so the list never has a
    // `nextCursor`; moving to the end must not request another page.
    const context = await browser.newContext({ storageState: connectedStatePath });
    const page = await context.newPage();
    const cursorRequests: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname.endsWith('/v1/runs') && url.searchParams.has('cursor')) {
        cursorRequests.push(request.url());
      }
    });
    try {
      await page.goto(`${fakeServer.baseUrl}/runs`);
      await expect(dataRows(page)).toHaveCount(scenarios.length);

      // Focus the list on the first (selected) row, then press `j` through the rest,
      // recording each distinct run the selection lands on.
      const seen = new Set<string>();
      const firstId = await selectedRow(page).getAttribute('data-run-id');
      expect(firstId).not.toBeNull();
      if (firstId !== null) {
        seen.add(firstId);
        await page.locator(`[data-run-id="${firstId}"]`).click();
      }
      let previousId = firstId;
      for (let i = 0; i < scenarios.length - 1; i += 1) {
        await page.keyboard.press('j');
        // Wait for the selection to move before reading it; the pane now does more work per
        // selection, so reading the row straight after the key press can see the old row.
        await expect(selectedRow(page)).not.toHaveAttribute('data-run-id', previousId ?? '');
        const id = await selectedRow(page).getAttribute('data-run-id');
        if (id !== null) {
          seen.add(id);
          previousId = id;
        }
      }
      // Every seeded run was observed while moving through the list.
      expect(seen.size).toBe(scenarios.length);

      // Pressing `j` again at the last row is a no-op for paging; give any erroneous
      // request time to fire before asserting none did.
      await page.keyboard.press('j');
      await page.waitForTimeout(500);
      expect(cursorRequests).toEqual([]);
    } finally {
      await context.close();
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

test.describe('run list geometry', () => {
  test('keeps every row cell within its own column with no overlap at min and max pane width', async ({
    browser,
    fakeServer,
    connectedStatePath
  }) => {
    for (const scenario of ['spec-review', 'implementation-review', 'pr-open', 'merged', 'failed']) {
      await fakeServer.seed({ scenario });
    }
    const { page, close } = await openRuns(browser, connectedStatePath, `${fakeServer.baseUrl}/runs`, {
      viewport: { width: 1024, height: 700 }
    });
    try {
      await expect(dataRows(page)).toHaveCount(5);

      const assertNoOverlap = async (): Promise<void> => {
        const rows = await dataRows(page).all();
        for (const row of rows) {
          const cells = row.locator('[role="gridcell"]');
          const count = await cells.count();
          expect(count).toBe(5);
          let previousRight = -Infinity;
          for (let i = 0; i < count; i += 1) {
            const box = await cells.nth(i).boundingBox();
            expect(box).not.toBeNull();
            if (box) {
              // Each cell starts at or after the previous cell's right edge: no overlap.
              expect(box.x).toBeGreaterThanOrEqual(previousRight - EDGE);
              previousRight = box.x + box.width;
            }
          }
        }
      };

      await assertNoOverlap();

      // Minimum pane width → widest list. ArrowRight narrows the right-hand pane.
      await page.getByRole('separator').focus();
      for (let i = 0; i < 60; i += 1) {
        await page.keyboard.press('ArrowRight');
      }
      await page.waitForTimeout(200);
      await assertNoOverlap();

      // Maximum pane width → narrowest list. ArrowLeft widens the pane.
      for (let i = 0; i < 120; i += 1) {
        await page.keyboard.press('ArrowLeft');
      }
      await page.waitForTimeout(200);
      await assertNoOverlap();
    } finally {
      await close();
    }
  });

  test('keeps the column header sticky while the list scrolls vertically', async ({
    browser,
    fakeServer,
    connectedStatePath
  }) => {
    for (const scenario of ['spec-review', 'implementation-review', 'pr-open', 'merged', 'failed']) {
      await fakeServer.seed({ scenario });
    }
    const { page, close } = await openRuns(browser, connectedStatePath, `${fakeServer.baseUrl}/runs`, {
      viewport: { width: 1024, height: 240 }
    });
    try {
      await expect(dataRows(page)).toHaveCount(5);
      const grid = page.getByRole('grid', { name: 'Runs' });
      // The short viewport forces the list to scroll vertically.
      expect(await grid.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);

      const headerBefore = await page.getByTestId('run-table-header').boundingBox();
      const firstRowBefore = await dataRows(page).first().boundingBox();
      await grid.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      await page.waitForTimeout(100);
      const headerAfter = await page.getByTestId('run-table-header').boundingBox();
      const firstRowAfter = await dataRows(page).first().boundingBox();

      expect(headerBefore && headerAfter && firstRowBefore && firstRowAfter).toBeTruthy();
      if (headerBefore && headerAfter && firstRowBefore && firstRowAfter) {
        // The sticky header's top edge is unchanged by the scroll.
        expect(Math.abs(headerAfter.y - headerBefore.y)).toBeLessThanOrEqual(EDGE);
        // The first row scrolled up, out from under the sticky header.
        expect(firstRowAfter.y).toBeLessThan(firstRowBefore.y - 1);
      }
    } finally {
      await close();
    }
  });

  test('scrolls the list horizontally with an aligned header below the grid minimum width', async ({
    browser,
    fakeServer,
    connectedStatePath
  }) => {
    await fakeServer.seed({ scenario: 'spec-review' });
    const { page, close } = await openRuns(browser, connectedStatePath, `${fakeServer.baseUrl}/runs`, {
      viewport: { width: 600, height: 700 }
    });
    try {
      await expect(dataRows(page)).toHaveCount(1);
      const grid = page.getByRole('grid', { name: 'Runs' });
      // The grid's minimum width exceeds the 600px viewport, so it scrolls sideways.
      expect(await grid.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);

      const headerCell = page.locator('[data-testid="run-table-header"] [role="columnheader"]').first();
      const rowCell = page.locator('[role="row"][data-run-id] [role="gridcell"]').first();
      await grid.evaluate((el) => {
        el.scrollLeft = 80;
      });
      await page.waitForTimeout(100);
      const headerBox = await headerCell.boundingBox();
      const rowBox = await rowCell.boundingBox();
      expect(headerBox && rowBox).toBeTruthy();
      if (headerBox && rowBox) {
        // The header row scrolls in the same horizontal context as the body: the first
        // header cell and the first body cell keep aligned left edges.
        expect(Math.abs(headerBox.x - rowBox.x)).toBeLessThanOrEqual(EDGE);
      }
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

    test('dragging and arrow-resizing the separator move the pane edge and the footer zone follows', async ({
      browser,
      fakeServer,
      connectedStatePath
    }) => {
      await fakeServer.seed({ scenario: 'spec-review' });
      const { page, close } = await openRuns(browser, connectedStatePath, `${fakeServer.baseUrl}/runs`, {
        colorScheme: scheme
      });
      try {
        await expect(dataRows(page)).toHaveCount(1);
        const pane = page.getByRole('complementary', { name: 'Run detail' });
        const paneZone = page.getByRole('group', { name: 'Detail pane' });

        // Drag the handle left to widen the pane. The pane sits on the right, so moving
        // the handle left grows it.
        const paneBefore = await pane.boundingBox();
        const handle = await page.getByRole('separator').boundingBox();
        expect(paneBefore).not.toBeNull();
        expect(handle).not.toBeNull();
        if (handle) {
          const cy = handle.y + handle.height / 2;
          const cx = handle.x + handle.width / 2;
          await page.mouse.move(cx, cy);
          await page.mouse.down();
          await page.mouse.move(cx - 48, cy, { steps: 6 });
          await page.mouse.up();
        }
        const paneDragged = await pane.boundingBox();
        if (paneBefore && paneDragged) {
          // The pane grew.
          expect(paneDragged.width).toBeGreaterThan(paneBefore.width + 1);
        }
        // The footer detail-pane zone's width animates (`--duration-layout`), so let the
        // transition settle before asserting its left edge tracks the pane.
        await page.waitForTimeout(400);
        const draggedZone = await paneZone.boundingBox();
        const paneAfterSettle = await pane.boundingBox();
        if (paneAfterSettle && draggedZone) {
          expect(Math.abs(draggedZone.x - paneAfterSettle.x)).toBeLessThanOrEqual(EDGE);
        }

        // Arrow-resize by one 16 px step. ArrowLeft widens the right-hand pane.
        await page.getByRole('separator').focus();
        const beforeKey = await pane.boundingBox();
        await page.keyboard.press('ArrowLeft');
        const afterKey = await pane.boundingBox();
        if (beforeKey && afterKey) {
          expect(Math.abs(afterKey.width - (beforeKey.width + 16))).toBeLessThanOrEqual(1);
        }
        // Again let the footer zone's width transition settle before measuring.
        await page.waitForTimeout(400);
        const keyZone = await paneZone.boundingBox();
        const paneAfterKeySettle = await pane.boundingBox();
        if (paneAfterKeySettle && keyZone) {
          expect(Math.abs(keyZone.x - paneAfterKeySettle.x)).toBeLessThanOrEqual(EDGE);
        }
      } finally {
        await close();
      }
    });

    for (const sidebar of ['open', 'closed'] as const) {
      test(`pane, handle, and footer zones align with the sidebar ${sidebar}`, async ({
        browser,
        fakeServer,
        connectedStatePath
      }) => {
        await fakeServer.seed({ scenario: 'spec-review' });
        const { page, close } = await openRuns(browser, connectedStatePath, `${fakeServer.baseUrl}/runs`, {
          colorScheme: scheme
        });
        try {
          await expect(dataRows(page)).toHaveCount(1);
          if (sidebar === 'closed') {
            // Collapse the sidebar and let the layout animation settle.
            await page.locator('body').press('[');
            await page.waitForTimeout(400);
          }

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
            expect(Math.abs(paneBar.y - header.y)).toBeLessThanOrEqual(EDGE);
            expect(Math.abs(paneBar.height - header.height)).toBeLessThanOrEqual(EDGE);
            expect(Math.abs(handle.x + handle.width - pane.x)).toBeLessThanOrEqual(EDGE);
            expect(Math.abs(paneZone.x - pane.x)).toBeLessThanOrEqual(EDGE);
          }
        } finally {
          await close();
        }
      });
    }

    test('the settings route disables the pane toggle, collapses its zone, and keeps the toggle in place', async ({
      browser,
      fakeServer,
      connectedStatePath
    }) => {
      await fakeServer.seed({ scenario: 'spec-review' });
      const context = await browser.newContext({ storageState: connectedStatePath, colorScheme: scheme });
      const page = await context.newPage();
      const toggle = page.getByRole('button', { name: 'Toggle detail pane' });
      try {
        // On the runs route the toggle is enabled and sits in the right control zone.
        await page.goto(`${fakeServer.baseUrl}/runs`);
        await expect(dataRows(page)).toHaveCount(1);
        await expect(toggle).not.toHaveAttribute('aria-disabled', 'true');
        const runsToggleBox = await toggle.boundingBox();

        // Off the runs route the detail-pane zone is zero width, the toggle is disabled,
        // and it keeps its final bounding box.
        await page.goto(`${fakeServer.baseUrl}/settings/connection`);
        await expect(page.getByRole('contentinfo')).toBeVisible();
        await expect(toggle).toHaveAttribute('aria-disabled', 'true');
        await page.waitForTimeout(400);
        const settingsZone = await page.getByRole('group', { name: 'Detail pane' }).boundingBox();
        expect(settingsZone).not.toBeNull();
        if (settingsZone) {
          expect(settingsZone.width).toBeLessThanOrEqual(EDGE);
        }
        const settingsToggleBox = await toggle.boundingBox();
        if (runsToggleBox && settingsToggleBox) {
          for (const key of ['x', 'y', 'width', 'height'] as const) {
            expect(Math.abs(runsToggleBox[key] - settingsToggleBox[key])).toBeLessThanOrEqual(EDGE);
          }
        }
      } finally {
        await context.close();
      }
    });
  });
}
