/**
 * Run detail pane end-to-end coverage against fake mode on the production path.
 *
 * Each test opens the built client served by its own fake control plane, authenticated
 * through the connected storage-state fixture (the real Connection page — no injected
 * token). Scenarios are seeded through the SDK-backed seed entry; runs are advanced only
 * through the real `replies` endpoint (the same call `replyToRun` makes). No test routes
 * around the API, writes browser storage, or makes a model call.
 */
import { expect, test, FIXTURE_TOKEN } from './fixtures/connected.js';
import type { Browser, BrowserContextOptions, Page } from '@playwright/test';

const EDGE = 0.5;

async function openRun(
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

/** Approve a run through the real replies endpoint (the call `replyToRun` makes). */
async function approve(baseUrl: string, runId: string): Promise<void> {
  const response = await fetch(`${baseUrl}/v1/runs/${runId}/replies`, {
    method: 'POST',
    headers: { authorization: `Bearer ${FIXTURE_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'approve', body: 'Approved from the run-detail e2e.' })
  });
  if (!response.ok) {
    throw new Error(`approve failed: ${response.status}`);
  }
}

test.describe('run detail pane', () => {
  test('fills the pane for every seeded scenario', async ({ browser, fakeServer, connectedStatePath }) => {
    const seeds: Record<string, string> = {};
    for (const scenario of ['spec-review', 'implementation-review', 'pr-open', 'merged', 'failed']) {
      const result = await fakeServer.seed({ scenario });
      seeds[scenario] = result.runId;
    }

    const { page, close } = await openRun(browser, connectedStatePath, `${fakeServer.baseUrl}/runs/${seeds['spec-review']}`);
    try {
      // Header and Summary render for the selected run.
      const pane = page.getByRole('complementary', { name: 'Run detail' });
      await expect(pane).toBeVisible();
      await expect(page.getByTestId('pane-run-title')).not.toHaveText('');
      // spec-review is in progress, so Summary shows the step row (the header owns the state).
      await expect(page.getByTestId('pane-summary-step')).toBeVisible();

      // pr-open and merged show a linked pull request row.
      for (const scenario of ['pr-open', 'merged']) {
        await page.goto(`${fakeServer.baseUrl}/runs/${seeds[scenario]}`);
        await expect(page.getByTestId('pane-summary-pr')).toContainText('#');
      }

      // The failed run shows its failure reason on the state fact.
      await page.goto(`${fakeServer.baseUrl}/runs/${seeds['failed']}`);
      await expect(page.getByTestId('pane-summary-failure')).toBeVisible();
    } finally {
      await close();
    }
  });

  test('keeps the selected tab when moving to the next run', async ({ browser, fakeServer, connectedStatePath }) => {
    for (const scenario of ['spec-review', 'implementation-review']) {
      await fakeServer.seed({ scenario });
    }
    const { page, close } = await openRun(browser, connectedStatePath, `${fakeServer.baseUrl}/runs`);
    try {
      await expect(page.locator('[role="row"][data-run-id]')).toHaveCount(2);
      const firstId = await page.locator('[role="row"][aria-selected="true"]').getAttribute('data-run-id');

      // Select the Activity tab, then move to the next run with the keyboard.
      await page.getByRole('tab', { name: 'Activity' }).click();
      await expect(page.getByRole('tab', { name: 'Activity' })).toHaveAttribute('aria-selected', 'true');

      await page.locator(`[role="row"][data-run-id="${firstId}"]`).click();
      await page.keyboard.press('j');
      const secondId = await page.locator('[role="row"][aria-selected="true"]').getAttribute('data-run-id');
      expect(secondId).not.toBe(firstId);
      // Activity stays selected on the next run.
      await expect(page.getByRole('tab', { name: 'Activity' })).toHaveAttribute('aria-selected', 'true');
    } finally {
      await close();
    }
  });

  test('updates the state line from the event stream when the run is approved, without a reload', async ({
    browser,
    fakeServer,
    connectedStatePath
  }) => {
    const { runId } = await fakeServer.seed({ scenario: 'spec-review' });
    const { page, close } = await openRun(browser, connectedStatePath, `${fakeServer.baseUrl}/runs/${runId}`);
    try {
      // Waiting on the operator at spec review; the header shows the Needs review chip and the
      // Summary step row shows the spec step.
      await expect(page.getByTestId('pane-status')).toHaveText('Needs review');
      await expect(page.getByTestId('pane-summary-step')).toContainText('spec.human_review');

      // The Spec tab shows a spec empty state.
      await page.getByRole('tab', { name: 'Spec' }).click();
      await expect(page.getByTestId('pane-spec-empty')).toBeVisible();

      // Approve through the API; the stream drives the pane forward without a reload.
      // The run advances past spec review into implementation — a change that sticks.
      await page.getByRole('tab', { name: 'Summary' }).click();
      await approve(fakeServer.baseUrl, runId);
      await expect(page.getByTestId('pane-summary-step')).toContainText('implementation', { timeout: 15_000 });
    } finally {
      await close();
    }
  });

  test('catches the pane up after the control plane restarts on the same port and state dir', async ({
    browser,
    fakeServer,
    connectedStatePath
  }) => {
    const { runId } = await fakeServer.seed({ scenario: 'spec-review' });
    const { page, close } = await openRun(browser, connectedStatePath, `${fakeServer.baseUrl}/runs/${runId}`);
    try {
      await expect(page.getByTestId('pane-summary-step')).toContainText('spec.human_review');

      // Bounce the control plane on the same port + state directory (no serve-fake).
      await fakeServer.restart();

      // After the client reconnects, approving drives the pane forward (catch-up):
      // the step advances past spec review into implementation.
      await approve(fakeServer.baseUrl, runId);
      await expect(page.getByTestId('pane-summary-step')).toContainText('implementation', { timeout: 30_000 });
    } finally {
      await close();
    }
  });

  test('shows the same status chip text in the list row and the pane header for every scenario', async ({
    browser,
    fakeServer,
    connectedStatePath
  }) => {
    const seeds: Record<string, string> = {};
    for (const scenario of ['spec-review', 'implementation-review', 'pr-open', 'merged', 'failed']) {
      const result = await fakeServer.seed({ scenario });
      seeds[scenario] = result.runId;
    }
    const { page, close } = await openRun(browser, connectedStatePath, `${fakeServer.baseUrl}/runs`);
    try {
      await expect(page.locator('[role="row"][data-run-id]')).toHaveCount(5);
      for (const scenario of ['spec-review', 'implementation-review', 'pr-open', 'merged', 'failed']) {
        const runId = seeds[scenario];
        await page.locator(`[role="row"][data-run-id="${runId}"]`).click();
        await expect(page.getByRole('complementary', { name: 'Run detail' })).toHaveAttribute(
          'data-pane-run-id',
          runId ?? ''
        );
        // The list row's status cell is the third grid cell; its chip text must equal the pane
        // header status chip text, because both derive from the one runStateChip mapping.
        const rowChip = (
          await page
            .locator(`[role="row"][data-run-id="${runId}"] [role="gridcell"]`)
            .nth(2)
            .innerText()
        ).trim();
        const paneChip = (await page.getByTestId('pane-status').innerText()).trim();
        expect(rowChip).not.toBe('');
        expect(paneChip).toBe(rowChip);
      }
    } finally {
      await close();
    }
  });

  test('pins the pane bar, header, and tabs while only the active tab content scrolls', async ({
    browser,
    fakeServer,
    connectedStatePath
  }) => {
    await fakeServer.seed({ scenario: 'spec-review' });
    // A short viewport forces the Summary content to overflow its scroll region.
    const { page, close } = await openRun(browser, connectedStatePath, `${fakeServer.baseUrl}/runs`, {
      viewport: { width: 1024, height: 320 }
    });
    try {
      await expect(page.locator('[role="row"][data-run-id]')).toHaveCount(1);

      const topEdges = async (): Promise<{ bar: number; title: number; tabs: number }> => {
        const bar = await page.getByTestId('pane-bar').boundingBox();
        const title = await page.getByTestId('pane-run-title').boundingBox();
        const tabs = await page.getByRole('tablist').boundingBox();
        expect(bar && title && tabs).toBeTruthy();
        return { bar: bar?.y ?? NaN, title: title?.y ?? NaN, tabs: tabs?.y ?? NaN };
      };

      const assertPinnedWhileTabScrolls = async (): Promise<void> => {
        for (const tab of ['Summary', 'Spec', 'Acceptance', 'Activity']) {
          await page.getByRole('tab', { name: tab }).click();
          // Base UI keeps inactive panels mounted but `inert`; the active panel is the only
          // non-inert tabpanel. Let the tab switch settle before measuring.
          await page.waitForTimeout(150);
          const panel = page.locator('[role="tabpanel"]:not([inert])');
          const before = await topEdges();
          // Scroll the active panel to its end; the pane chrome must not move.
          await panel.evaluate((el) => {
            el.scrollTop = el.scrollHeight;
          });
          if (tab === 'Summary') {
            // Summary overflows the short viewport, so its panel genuinely scrolls.
            const overflow = await panel.evaluate((el) => el.scrollHeight > el.clientHeight);
            expect(overflow).toBe(true);
            const scrolled = await panel.evaluate((el) => el.scrollTop);
            expect(scrolled).toBeGreaterThan(0);
          }
          const after = await topEdges();
          expect(Math.abs(after.bar - before.bar)).toBeLessThanOrEqual(EDGE);
          expect(Math.abs(after.title - before.title)).toBeLessThanOrEqual(EDGE);
          expect(Math.abs(after.tabs - before.tabs)).toBeLessThanOrEqual(EDGE);
        }
      };

      // Default pane width.
      await assertPinnedWhileTabScrolls();

      // Minimum pane width (ArrowRight narrows the right-hand pane).
      await page.getByRole('separator').focus();
      for (let i = 0; i < 60; i += 1) {
        await page.keyboard.press('ArrowRight');
      }
      await page.waitForTimeout(200);
      await assertPinnedWhileTabScrolls();

      // Maximum pane width (ArrowLeft widens it).
      await page.getByRole('separator').focus();
      for (let i = 0; i < 120; i += 1) {
        await page.keyboard.press('ArrowLeft');
      }
      await page.waitForTimeout(200);
      await assertPinnedWhileTabScrolls();
    } finally {
      await close();
    }
  });
});

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`run detail geometry (${scheme})`, () => {
    test.use({ colorScheme: scheme });

    test('header, meta, tabs, and scrolling body stay within the pane at default, min, and max widths', async ({
      browser,
      fakeServer,
      connectedStatePath
    }) => {
      await fakeServer.seed({ scenario: 'spec-review' });
      const { page, close } = await openRun(browser, connectedStatePath, `${fakeServer.baseUrl}/runs`, {
        colorScheme: scheme
      });
      try {
        await expect(page.locator('[role="row"][data-run-id]')).toHaveCount(1);

        const assertLayout = async (): Promise<void> => {
          const pane = await page.getByRole('complementary', { name: 'Run detail' }).boundingBox();
          const bar = await page.getByTestId('pane-bar').boundingBox();
          const title = await page.getByTestId('pane-run-title').boundingBox();
          const meta = await page.getByTestId('pane-meta').boundingBox();
          const tabs = await page.getByRole('tablist').boundingBox();
          const body = await page.getByTestId('pane-body').boundingBox();
          expect(pane && bar && title && meta && tabs && body).toBeTruthy();
          if (pane && bar && title && meta && tabs && body) {
            // The body scrolls under the pane bar.
            expect(body.y).toBeGreaterThanOrEqual(bar.y + bar.height - EDGE);
            // Title, meta, and tabs stay within the pane's horizontal bounds.
            for (const box of [title, meta, tabs]) {
              expect(box.x).toBeGreaterThanOrEqual(pane.x - EDGE);
              expect(box.x + box.width).toBeLessThanOrEqual(pane.x + pane.width + EDGE);
            }
            // Stacking order: title above meta, meta above tabs.
            expect(title.y).toBeLessThanOrEqual(meta.y + EDGE);
            expect(meta.y).toBeLessThanOrEqual(tabs.y + EDGE);
          }
        };

        await assertLayout();

        // Shrink to the minimum, then grow to the maximum, asserting the layout holds.
        await page.getByRole('separator').focus();
        for (let i = 0; i < 60; i += 1) {
          await page.keyboard.press('ArrowRight');
        }
        await page.waitForTimeout(200);
        await assertLayout();

        for (let i = 0; i < 120; i += 1) {
          await page.keyboard.press('ArrowLeft');
        }
        await page.waitForTimeout(200);
        await assertLayout();
      } finally {
        await close();
      }
    });
  });
}
