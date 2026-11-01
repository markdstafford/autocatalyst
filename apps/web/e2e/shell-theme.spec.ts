/**
 * Issue-scoped appearance checks for the rendered shell: a dark system scheme applies
 * the dark theme background, geometry is unchanged in dark mode, and rendered shell
 * text meets contrast in one light and one dark theme. #131 owns the full eight-theme
 * unit contrast sweep; this only checks what is actually rendered here. No spec writes
 * browser storage.
 */
import type { Page } from '@playwright/test';

import { expect, test } from './fixtures/fake-server.js';

async function textContrast(page: Page, selector: string): Promise<number> {
  return page.evaluate((sel) => {
    const parse = (c: string): [number, number, number] => {
      const m = (c.match(/[\d.]+/g) ?? []).map(Number);
      return [m[0] ?? 0, m[1] ?? 0, m[2] ?? 0];
    };
    const lum = ([r, g, b]: [number, number, number]): number => {
      const f = (v: number): number => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const ratio = (a: string, b: string): number => {
      const la = lum(parse(a));
      const lb = lum(parse(b));
      const hi = Math.max(la, lb);
      const lo = Math.min(la, lb);
      return (hi + 0.05) / (lo + 0.05);
    };

    const el = document.querySelector(sel);
    if (el === null) throw new Error(`no element for ${sel}`);
    const color = getComputedStyle(el).color;
    let node: Element | null = el;
    let bg = 'rgba(0, 0, 0, 0)';
    while (node !== null) {
      const c = getComputedStyle(node).backgroundColor;
      if (c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') {
        bg = c;
        break;
      }
      node = node.parentElement;
    }
    return ratio(color, bg);
  }, selector);
}

async function colorVar(page: Page, name: string): Promise<string> {
  return page.evaluate((v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim(), name);
}

test('dark system scheme applies the dark background and keeps geometry', async ({ page, fakeServer }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(`${fakeServer.baseUrl}/runs`);

  const mode = await page.evaluate(() => document.documentElement.getAttribute('data-theme-mode'));
  expect(mode).toBe('dark');

  // Body background equals the resolved theme's --color-background.
  const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const token = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.backgroundColor = 'var(--color-background)';
    document.body.appendChild(probe);
    const c = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return c;
  });
  expect(bodyBg).toBe(token);

  // Geometry unchanged: footer still spans the width at the bottom.
  const vp = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const footer = await page.getByRole('contentinfo').boundingBox();
  expect(footer).not.toBeNull();
  if (footer !== null) {
    expect(Math.abs(footer.x)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(footer.width - vp.w)).toBeLessThanOrEqual(0.5);
    expect(footer.y + footer.height).toBeLessThanOrEqual(vp.h + 0.5);
  }
});

for (const scheme of ['light', 'dark'] as const) {
  test(`rendered shell text meets contrast (${scheme})`, async ({ page, fakeServer }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(`${fakeServer.baseUrl}/runs`);
    await expect(page.getByRole('heading', { level: 1, name: 'Runs' })).toBeVisible();

    // Header title (primary text) and the empty-state line (subtext) on background.
    expect(await textContrast(page, 'h1')).toBeGreaterThanOrEqual(4.5);
    expect(await textContrast(page, 'p')).toBeGreaterThanOrEqual(4.5);

    // Sanity: the focus token exists for this theme.
    expect(await colorVar(page, '--color-focus')).not.toBe('');
  });
}
