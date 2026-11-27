/// <reference lib="dom" />
import { createControlPlaneClient } from '@autocatalyst/sdk';
import type { Locator, Page } from '@playwright/test';

import { expect, FIXTURE_TOKEN, test } from './fixtures/connected.js';

const EDGE = 0.5;
const strip = (page: Page) => page.getByRole('region', { name: 'Collection views' });
const chip = (page: Page, name: string) => strip(page).getByRole('button', { name, exact: true });
const primary = (page: Page) => page.getByRole('navigation', { name: 'Primary' });
const row = (page: Page, name: string) => primary(page).getByRole('link', { name, exact: true });
const grid = (page: Page) => page.getByRole('grid', { name: 'Runs' });
const banner = (page: Page) => page.getByRole('banner');
const actions = (page: Page) => page.getByRole('button', { name: 'View settings' });

async function createView(page: Page, name: string): Promise<void> {
  await chip(page, 'Create named view').click();
  const dialog = page.getByRole('dialog', { name: 'New view' });
  const field = dialog.getByRole('textbox', { name: 'Name' });
  await expect(field).toBeFocused();
  await field.fill(name);
  await field.press('Enter');
  await expect(chip(page, name)).toHaveAttribute('aria-current', 'true');
  await expect(dialog).toHaveCount(0);
}

test('persists named views without changing selected runs or scope', async ({ browser, fakeServer, connectedStatePath }) => {
  const seeded: string[] = [];
  for (const scenario of ['spec-review', 'implementation-review', 'pr-open', 'merged', 'failed']) {
    seeded.push((await fakeServer.seed({ scenario })).runId);
  }
  const sdk = createControlPlaneClient({ baseUrl: fakeServer.baseUrl, bearerToken: FIXTURE_TOKEN });
  const fixture = (await sdk.listProjects()).projects.find((project) => project.displayName === 'Fixture app');
  if (fixture === undefined) throw new Error('Expected the seeded Fixture app project.');
  const projectId = fixture.id;

  const context = await browser.newContext({ storageState: connectedStatePath });
  try {
    const page = await context.newPage();
    await page.goto(`${fakeServer.baseUrl}/runs`);
    const runs = grid(page).locator('[data-run-id]');
    async function assertRows(): Promise<void> {
      await expect(runs).toHaveCount(5);
      expect((await runs.evaluateAll((loaded) => loaded.map((run) => run.getAttribute('data-run-id')))).sort())
        .toEqual([...seeded].sort());
    }
    await assertRows();
    await expect(banner(page).getByRole('heading', { name: 'All runs' })).toBeVisible();
    await runs.nth(1).click();
    const unscopedId = await runs.nth(1).getAttribute('data-run-id');

    async function assertView(name: string, id: string | null, scoped = false): Promise<void> {
      await expect(banner(page).getByRole('heading', { name, exact: true })).toBeVisible();
      await expect(strip(page).locator('[aria-current="true"]')).toHaveCount(1);
      await expect(chip(page, name)).toHaveAttribute('aria-current', 'true');
      await expect(primary(page).locator('[aria-current="page"]')).toHaveCount(1);
      await expect(row(page, name)).toHaveAttribute('aria-current', 'page');
      const selected = grid(page).locator('[aria-selected="true"]');
      await expect(selected).toHaveCount(1);
      await expect(selected).toHaveAttribute('data-run-id', id ?? '');
      const query = scoped ? `?${new URLSearchParams({ project: projectId })}` : '';
      await expect(page).toHaveURL(`${fakeServer.baseUrl}/runs/${id}${query}`);
      await expect(banner(page).getByText('Fixture app', { exact: true })).toHaveCount(scoped ? 1 : 0);
      await assertRows();
    }

    await assertView('All runs', unscopedId);
    await createView(page, 'Review');
    await assertView('Review', unscopedId);
    await actions(page).click();
    await page.getByRole('menuitem', { name: 'Rename view' }).click();
    const name = page.getByRole('textbox', { name: 'Name' });
    await expect(name).toHaveValue('Review');
    await expect(name).toBeFocused();
    await name.fill('My review');
    await name.press('Enter');
    await assertView('My review', unscopedId);

    await chip(page, 'All runs').click();
    await assertView('All runs', unscopedId);
    await row(page, 'My review').click();
    await assertView('My review', unscopedId);
    await row(page, 'All runs').click();
    await assertView('All runs', unscopedId);
    await page.keyboard.press('.');
    await assertView('My review', unscopedId);

    await row(page, 'Fixture app').click();
    await assertRows();
    await runs.nth(2).click();
    const scopedId = await runs.nth(2).getAttribute('data-run-id');
    await assertView('My review', scopedId, true);
    await page.keyboard.press(',');
    await assertView('All runs', scopedId, true);
    await page.keyboard.press('.');
    await assertView('My review', scopedId, true);

    await page.reload();
    await assertView('My review', scopedId, true);
    await actions(page).click();
    await page.getByRole('menuitem', { name: 'Delete view' }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete view' });
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await dialog.getByRole('button', { name: 'Delete view' }).click();
    await assertView('All runs', scopedId, true);
    await actions(page).press('Enter');
    const last = page.getByRole('menuitem', { name: 'Delete view' });
    await expect(last).toHaveAttribute('aria-disabled', 'true');
    await page.keyboard.press('ArrowDown');
    await expect(last).toBeFocused();
    await expect(page.getByRole('tooltip').filter({ hasText: 'The last view cannot be deleted' })).toBeVisible();
    await page.reload();
    await assertView('All runs', scopedId, true);
    await expect(strip(page).getByRole('button')).toHaveCount(2);
  } finally {
    await context.close();
  }
});

async function bounds(element: Locator) {
  const box = await element.boundingBox();
  if (box === null) throw new Error('Expected a visible layout box.');
  return box;
}

async function baseline(element: Locator): Promise<number> {
  return element.evaluate((label) => {
    const marker = document.createElement('span');
    marker.style.display = 'inline-block';
    marker.style.verticalAlign = 'baseline';
    label.appendChild(marker);
    const baseline = marker.getBoundingClientRect().bottom;
    marker.remove();
    return baseline;
  });
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`keeps twelve chips in one row and reveals a view without moving focus (${colorScheme})`,
    async ({ browser, connectedStatePath, fakeServer }) => {
      await fakeServer.seed({ scenario: 'spec-review' });
      const context = await browser.newContext({ storageState: connectedStatePath, colorScheme, viewport: { width: 1060, height: 420 } });
      try {
        const page = await context.newPage();
        await page.goto(`${fakeServer.baseUrl}/runs`);
        await expect(grid(page)).toBeVisible();
        const names = Array.from({ length: 11 }, (_, index) => `Review queue ${index + 1} with a long name for truncation`);
        for (const name of names) await createView(page, name);
        const chips = strip(page);
        const targetName = names.at(-2)!;
        const target = chip(page, targetName);
        const link = row(page, targetName);

        async function assertGeometry(sidebarOpen: boolean): Promise<void> {
          const title = page.getByTestId('header-title');
          const titleBox = await bounds(title);
          const bannerBox = await bounds(banner(page));
          const chipRow = await bounds(chips);
          expect(Math.abs(chipRow.y - titleBox.y - titleBox.height)).toBeLessThanOrEqual(EDGE);
          expect(await title.evaluate((el) => parseFloat(getComputedStyle(el).borderBottomWidth))).toBe(0);
          expect(await chips.evaluate((el) => parseFloat(getComputedStyle(el).borderTopWidth))).toBe(0);
          expect(await banner(page).evaluate((el) => parseFloat(getComputedStyle(el).borderBottomWidth))).toBeGreaterThan(0);
          const height = await chips.evaluate((el) => {
            const style = getComputedStyle(el);
            const token = style.getPropertyValue('--height-chip-row').trim();
            return token.endsWith('rem') ? parseFloat(token) * parseFloat(getComputedStyle(document.documentElement).fontSize) : parseFloat(token);
          });
          expect(Math.abs(chipRow.height - height)).toBeLessThanOrEqual(EDGE);
          expect(await chips.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
          const boxes = await Promise.all((await chips.getByRole('button').all()).map(bounds));
          expect(boxes).toHaveLength(13);
          const tops = boxes.map((chip) => chip.y);
          expect(Math.max(...tops) - Math.min(...tops)).toBeLessThanOrEqual(EDGE);
          const columns = await bounds(page.getByTestId('run-table-header'));
          const pane = await bounds(page.getByTestId('pane-bar'));
          expect(Math.abs(columns.y - bannerBox.y - bannerBox.height)).toBeLessThanOrEqual(EDGE);
          expect(Math.abs(columns.y - pane.y)).toBeLessThanOrEqual(EDGE);
          expect(Math.abs(columns.height - pane.height)).toBeLessThanOrEqual(EDGE);
          if (!sidebarOpen) {
            expect(Math.abs(bannerBox.x)).toBeLessThanOrEqual(EDGE);
            return;
          }
          const sidebarTitle = page.getByTestId('sidebar-title');
          const navTitle = await bounds(sidebarTitle);
          expect(Math.abs(titleBox.y - navTitle.y)).toBeLessThanOrEqual(EDGE);
          expect(Math.abs(titleBox.height - navTitle.height)).toBeLessThanOrEqual(EDGE);
          expect(Math.abs(await baseline(title.getByRole('heading')) - await baseline(sidebarTitle.getByText('Autocatalyst')))).toBeLessThanOrEqual(1);
          const sidebarLabels = primary(page).getByRole('group', { name: 'Run views' }).getByRole('link');
          const hasOverlap = await sidebarLabels.evaluateAll((links) => links.some((link, i) => {
            const r = link.getBoundingClientRect();
            const label = link.firstElementChild?.getBoundingClientRect();
            const next = links[i + 1]?.getBoundingClientRect();
            return label === undefined || label.left < r.left || label.right > r.right ||
              label.top < r.top || label.bottom > r.bottom || (next !== undefined && next.top < r.bottom);
          }));
          expect(hasOverlap).toBe(false);
        }

        await assertGeometry(true);
        // The last view remains active; rewind only the strip.
        await chips.evaluate((el) => { el.scrollLeft = 0; });
        expect((await bounds(target)).x).toBeGreaterThan((await bounds(chips)).x + (await bounds(chips)).width);
        await link.focus();
        await expect(link).toBeFocused();
        const pageScroll = () => page.evaluate(() => [window.scrollX, window.scrollY]);
        const before = await pageScroll();
        await page.keyboard.press('Enter');
        await expect(target).toHaveAttribute('aria-current', 'true');
        await expect.poll(async () => chips.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
        const targetBox = await bounds(target);
        const stripBox = await bounds(chips);
        expect(targetBox.x).toBeGreaterThanOrEqual(stripBox.x - EDGE);
        expect(targetBox.x + targetBox.width).toBeLessThanOrEqual(stripBox.x + stripBox.width + EDGE);
        await expect(link).toBeFocused();
        expect(await pageScroll()).toEqual(before);

        await page.keyboard.press('[');
        await expect.poll(async () => (await bounds(banner(page))).x).toBeLessThanOrEqual(EDGE);
        await assertGeometry(false);
      } finally {
        await context.close();
      }
    });
}
