/**
 * Unit test for the e2e preflight. It runs as part of the e2e target (a
 * Playwright spec, not `vitest run`) because `apps/web` has no `test` target
 * yet — #131 adds the client's Vitest setup. The test stubs the path check, so
 * it launches no browser and touches no real filesystem.
 */
import { expect, test } from '@playwright/test';

import { checkBrowser } from './check-browser.mjs';

test('preflight passes silently when Chromium is present', () => {
  const result = checkBrowser({ executablePath: '/fake/chromium', exists: true });
  expect(result.ok).toBe(true);
  expect(result.code).toBe(0);
  expect(result.message).toBe('');
});

test('preflight fails with the install hint when Chromium is missing', () => {
  const result = checkBrowser({ executablePath: '/fake/chromium', exists: false });
  expect(result.ok).toBe(false);
  expect(result.code).toBe(1);
  expect(result.message).toContain('pnpm exec playwright install chromium');
});
