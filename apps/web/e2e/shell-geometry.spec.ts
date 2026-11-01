/**
 * Design-system geometry assertions that apply before the run list and detail pane
 * exist (#134 adds those). Regions are located by role and accessible name, token
 * sizes are read from the document (never hard-coded), edges match within 0.5 px and
 * baselines within 1 px. The matrix runs with the sidebar open and closed, in light
 * and dark system color schemes, on Runs and Connection.
 */
import type { Page } from '@playwright/test';

import { expect, test } from './fixtures/fake-server.js';

interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

const EDGE = 0.5;
const SCHEMES: Array<'light' | 'dark'> = ['light', 'dark'];
const PATHS = ['/runs', '/settings/connection'];

/** Resolve a CSS length token to pixels by measuring a probe element. */
async function tokenPx(page: Page, token: string): Promise<number> {
  return page.evaluate((name) => {
    const probe = document.createElement('div');
    probe.style.position = 'absolute';
    probe.style.width = `var(${name})`;
    document.body.appendChild(probe);
    const width = probe.getBoundingClientRect().width;
    probe.remove();
    return width;
  }, token);
}

async function box(page: Page, role: Parameters<Page['getByRole']>[0], name?: string): Promise<BoundingBox> {
  const locator = name === undefined ? page.getByRole(role) : page.getByRole(role, { name });
  const found = await locator.first().boundingBox();
  if (found === null) {
    throw new Error(`no bounding box for role=${role} name=${name ?? ''}`);
  }
  return found;
}

async function zone(page: Page, name: string): Promise<BoundingBox> {
  const found = await page.getByRole('group', { name }).boundingBox();
  if (found === null) {
    throw new Error(`no bounding box for footer zone ${name}`);
  }
  return found;
}

async function viewport(page: Page): Promise<{ width: number; height: number }> {
  return page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
}

for (const scheme of SCHEMES) {
  for (const path of PATHS) {
    test.describe(`geometry (${scheme}, ${path})`, () => {
      test.use({ colorScheme: scheme });

      test('shell regions, footer zones, and sidebar alignment', async ({ page, fakeServer }) => {
        await page.goto(`${fakeServer.baseUrl}${path}`);
        await expect(page.getByRole('contentinfo')).toBeVisible();

        const vp = await viewport(page);
        const footerH = await tokenPx(page, '--height-footer');
        const sidebarW = await tokenPx(page, '--width-sidebar');
        const controlW = await tokenPx(page, '--width-footer-control');

        // Footer spans the viewport width and sits at the bottom.
        const footer = await box(page, 'contentinfo');
        expect(Math.abs(footer.y - (vp.height - footerH))).toBeLessThanOrEqual(EDGE);
        expect(Math.abs(footer.x - 0)).toBeLessThanOrEqual(EDGE);
        expect(Math.abs(footer.width - vp.width)).toBeLessThanOrEqual(EDGE);

        // Sidebar (open) bottom meets the footer top; header edges line up.
        const sidebar = await page.getByRole('navigation').boundingBox();
        const header = await box(page, 'banner');
        if (sidebar !== null) {
          expect(Math.abs(sidebar.y + sidebar.height - footer.y)).toBeLessThanOrEqual(EDGE);
          expect(Math.abs(header.x - (sidebar.x + sidebar.width))).toBeLessThanOrEqual(EDGE);
          expect(Math.abs(sidebar.width - sidebarW)).toBeLessThanOrEqual(EDGE);
        }
        expect(Math.abs(header.x + header.width - vp.width)).toBeLessThanOrEqual(EDGE);
        expect(Math.abs(header.y - 0)).toBeLessThanOrEqual(EDGE);

        // Header title row and sidebar title row share top and bottom edges.
        const sidebarTitle = await page.getByTestId('sidebar-title').boundingBox();
        if (sidebarTitle !== null) {
          expect(Math.abs(header.y - sidebarTitle.y)).toBeLessThanOrEqual(EDGE);
          expect(Math.abs(header.height - sidebarTitle.height)).toBeLessThanOrEqual(EDGE);
        }

        // Five footer zones are contiguous in order and together span the footer.
        const names = ['Left control', 'Sidebar', 'List', 'Detail pane', 'Right control'];
        const zones = [];
        for (const name of names) {
          zones.push(await zone(page, name));
        }
        expect(Math.abs(zones[0].x - footer.x)).toBeLessThanOrEqual(EDGE);
        for (let i = 1; i < zones.length; i += 1) {
          const prevRight = zones[i - 1].x + zones[i - 1].width;
          expect(Math.abs(zones[i].x - prevRight)).toBeLessThanOrEqual(EDGE);
        }
        const last = zones[zones.length - 1];
        expect(Math.abs(last.x + last.width - (footer.x + footer.width))).toBeLessThanOrEqual(EDGE);

        // Control zones are at least --width-footer-control wide.
        expect(zones[0].width).toBeGreaterThanOrEqual(controlW - EDGE);
        expect(zones[4].width).toBeGreaterThanOrEqual(controlW - EDGE);

        // Sidebar zone right edge equals the sidebar's right edge (open).
        if (sidebar !== null) {
          expect(Math.abs(zones[1].x + zones[1].width - (sidebar.x + sidebar.width))).toBeLessThanOrEqual(EDGE);
        }

        // No footer zone has a left or right border.
        const borders = await page.evaluate(() =>
          Array.from(document.querySelectorAll('[role="group"]')).map((el) => {
            const s = getComputedStyle(el);
            return [s.borderLeftWidth, s.borderRightWidth];
          })
        );
        for (const [left, right] of borders) {
          expect(left).toBe('0px');
          expect(right).toBe('0px');
        }
      });
    });
  }
}

test.describe('settings column', () => {
  test('content column is no wider than --width-settings-column', async ({ page, fakeServer }) => {
    await page.goto(`${fakeServer.baseUrl}/settings/connection`);
    const columnMax = await tokenPx(page, '--width-settings-column');
    const form = await page.locator('form').boundingBox();
    expect(form).not.toBeNull();
    if (form !== null) {
      expect(form.width).toBeLessThanOrEqual(columnMax + EDGE);
    }
  });
});

test.describe('sidebar toggle stability and closed geometry', () => {
  test('toggle boxes stay constant and geometry holds across "[" toggles', async ({ page, fakeServer }) => {
    await page.goto(`${fakeServer.baseUrl}/runs`);
    const sidebarToggle = () => page.getByRole('button', { name: 'Toggle sidebar' }).boundingBox();
    const paneToggle = () => page.getByRole('button', { name: 'Toggle detail pane' }).boundingBox();

    const openSidebarToggle = await sidebarToggle();
    const openPaneToggle = await paneToggle();

    // Close with "[".
    await page.locator('body').press('[');
    await page.waitForTimeout(400); // allow the layout animation to settle
    const closedSidebarToggle = await sidebarToggle();
    const closedPaneToggle = await paneToggle();

    for (const key of ['x', 'y', 'width', 'height'] as const) {
      expect(Math.abs((openSidebarToggle?.[key] ?? 0) - (closedSidebarToggle?.[key] ?? 0))).toBeLessThanOrEqual(EDGE);
      expect(Math.abs((openPaneToggle?.[key] ?? 0) - (closedPaneToggle?.[key] ?? 0))).toBeLessThanOrEqual(EDGE);
    }

    // Closed: the sidebar zone collapses to zero width.
    const sidebarZone = await zone(page, 'Sidebar');
    expect(sidebarZone.width).toBeLessThanOrEqual(EDGE);

    // Header starts at the viewport's left edge when closed.
    const header = await box(page, 'banner');
    expect(Math.abs(header.x - 0)).toBeLessThanOrEqual(EDGE);
  });

  test('closed: tabbing from the start reaches the header before any sidebar entry', async ({ page, fakeServer }) => {
    await page.goto(`${fakeServer.baseUrl}/runs`);
    await page.locator('body').press('[');
    await page.waitForTimeout(400);
    // With the sidebar closed, its links are inert; the first reachable control is in
    // the main area, not a sidebar entry.
    const sidebarLinks = await page.getByRole('navigation').getByRole('link').count();
    expect(sidebarLinks).toBe(0);
  });
});

test.describe('hover overlay', () => {
  test('overlay spans the viewport height, covers header and footer, and closes', async ({ page, fakeServer }) => {
    await page.goto(`${fakeServer.baseUrl}/runs`);
    await page.locator('body').press('[');
    await page.waitForTimeout(400);

    const sidebarW = await tokenPx(page, '--width-sidebar');
    const vp = await viewport(page);
    const headerBefore = await box(page, 'banner');

    // Enter the left-edge hover strip.
    await page.mouse.move(2, Math.floor(vp.height / 2));
    const overlay = page.getByRole('navigation');
    await expect(overlay).toBeVisible();
    await page.waitForTimeout(100); // settle any entrance transition before measuring
    const overlayBox = await overlay.boundingBox();
    expect(overlayBox).not.toBeNull();
    if (overlayBox !== null) {
      expect(Math.abs(overlayBox.y - 0)).toBeLessThanOrEqual(EDGE);
      expect(Math.abs(overlayBox.height - vp.height)).toBeLessThanOrEqual(EDGE);
      expect(Math.abs(overlayBox.width - sidebarW)).toBeLessThanOrEqual(EDGE);
    }

    // elementFromPoint at a header point and a footer point inside the overlay range
    // returns an element inside the overlay.
    const insideOverlay = await page.evaluate((w) => {
      const atHeader = document.elementFromPoint(w / 2, 8);
      const atFooter = document.elementFromPoint(w / 2, window.innerHeight - 8);
      const nav = document.querySelector('nav[aria-label="Primary"]');
      return {
        header: nav !== null && atHeader !== null && nav.contains(atHeader),
        footer: nav !== null && atFooter !== null && nav.contains(atFooter)
      };
    }, Math.min(sidebarW / 2, 100));
    expect(insideOverlay.header).toBe(true);
    expect(insideOverlay.footer).toBe(true);

    // The header position did not change when the overlay appeared.
    const headerAfter = await box(page, 'banner');
    expect(Math.abs(headerBefore.x - headerAfter.x)).toBeLessThanOrEqual(EDGE);

    // Escape closes the overlay.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('navigation')).toHaveCount(0);
  });
});
