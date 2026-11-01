// Preflight for the `web` e2e target. Playwright keeps its browsers outside
// `node_modules`, and `pnpm install` does not download them, so the target
// checks that Chromium is on disk before it runs any test. A missing browser is
// a hard stop with a message naming the one-time install command — the target
// never downloads a browser itself and never skips the tests, because a skipped
// test reads as a pass.
import { existsSync } from 'node:fs';
import { argv, exit, stderr } from 'node:process';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

const INSTALL_HINT = 'pnpm exec playwright install chromium';

/**
 * Pure decision for the preflight. Injecting `executablePath` and `exists` keeps
 * it unit-testable without touching the real filesystem or a real browser.
 *
 * @param {{ executablePath?: string, exists?: boolean }} [input]
 * @returns {{ ok: boolean, code: number, message: string }}
 */
export function checkBrowser(input = {}) {
  const executablePath = input.executablePath ?? chromium.executablePath();
  const present = input.exists ?? existsSync(executablePath);
  if (!present) {
    return {
      ok: false,
      code: 1,
      message: `Chromium is not installed for Playwright. Run: ${INSTALL_HINT}`
    };
  }
  return { ok: true, code: 0, message: '' };
}

const invokedDirectly =
  argv[1] !== undefined && fileURLToPath(import.meta.url) === argv[1];

if (invokedDirectly) {
  const result = checkBrowser();
  if (!result.ok) {
    stderr.write(`${result.message}\n`);
  }
  exit(result.code);
}
