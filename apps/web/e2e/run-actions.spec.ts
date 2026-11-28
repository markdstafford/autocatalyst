import type { Page } from '@playwright/test';

import { expect, test } from './fixtures/connected.js';

const row = (page: Page, id: string) => page.getByTestId(`run-row-${id}`);
const attempt = (page: Page, step: string) => page.getByRole('tabpanel').locator(`[data-activity-step="${step}"]`);
const outcome = (page: Page) => page.getByTestId('run-action-outcome');

test.use({ storageState: ({ connectedStatePath }, use) => use(connectedStatePath) });

test('recovers the seeded one-shot spec failure without choosing a mode', async ({ page, fakeServer }) => {
  const { runId } = await fakeServer.seed({ scenario: 'failed' });
  await page.goto(`${fakeServer.baseUrl}/runs/${runId}`);
  await expect(page.getByTestId('pane-status')).toHaveText('Failed');
  await page.getByRole('tab', { name: 'Activity' }).click();
  const authors = attempt(page, 'spec.author');
  await expect(authors).toHaveCount(1);
  await expect(authors).toContainText('Failed');
  await page.keyboard.press('Shift+R');
  await expect(outcome(page)).toHaveText(/^Recovered \((resumed|started over)\)$/u);
  await expect(attempt(page, 'spec.human_review').last()).toContainText('Waiting on you');
  await expect(authors).toHaveCount(2);
  await expect(page.getByTestId('pane-status')).toHaveText('Needs review');
});

test('checks matching menus, dismisses cancel, then cancels, archives and restores', async ({ page, fakeServer }) => {
  await fakeServer.seed({ scenario: 'failed' });
  await fakeServer.seed({ scenario: 'implementation-review' });
  await fakeServer.seed({ scenario: 'pr-open' });
  const finished = await fakeServer.seed({ scenario: 'merged' });
  const spec = await fakeServer.seed({ scenario: 'spec-review' });
  await page.goto(`${fakeServer.baseUrl}/runs/${spec.runId}`);
  const paneMenu = page.getByRole('button', { name: 'Run actions', exact: true });
  const rowMenu = (id: string) => row(page, id).getByRole('button', { name: /^Run actions for/u });
  const items = () => page.getByRole('menuitem');

  // Wait for the gated history read before comparing the exact menu entries.
  await paneMenu.click();
  await expect(items()).toHaveText([/^Cancel/u, /^Rename/u, /^Set step/u]);
  await page.keyboard.press('Escape');
  await rowMenu(finished.runId).click();
  await expect(items()).toHaveText([/^Archive/u, /^Rename/u]);
  await expect(row(page, spec.runId)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Escape');
  await row(page, finished.runId).click();
  await paneMenu.click();
  await expect(items()).toHaveText([/^Archive/u, /^Rename/u]);
  await page.keyboard.press('Escape');
  await row(page, spec.runId).click();
  await rowMenu(spec.runId).click();
  await expect(items()).toHaveText([/^Cancel/u, /^Rename/u, /^Set step/u]);
  await page.getByRole('menuitem', { name: 'Cancel', exact: true }).click();
  const alert = page.getByRole('alertdialog', { name: 'Cancel this run?' });
  await expect(alert.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(rowMenu(spec.runId)).toBeFocused();
  await expect(page.getByTestId('pane-status')).toHaveText('Needs review');
  await page.keyboard.press('Shift+X');
  await alert.getByRole('button', { name: 'Cancel run' }).click();
  await expect(page.getByTestId('pane-status')).toHaveText('Canceled');
  await expect(outcome(page)).toHaveText('Canceled');

  const ordered = await page.locator('[data-run-id]').evaluateAll(rows => rows.map(item => item.getAttribute('data-run-id')));
  const index = ordered.indexOf(spec.runId);
  const successor = ordered[index + 1] ?? ordered[index - 1]!;
  await page.keyboard.press('e');
  await expect(row(page, spec.runId)).toHaveCount(0);
  await expect(row(page, successor)).toHaveAttribute('aria-selected', 'true');
  await expect(outcome(page)).toHaveText('Archived');
  await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible();

  await page.keyboard.press('Shift+A');
  await expect(page.getByRole('heading', { name: 'Archived runs' })).toBeVisible();
  await row(page, spec.runId).click();
  await expect(page).toHaveURL(/\/runs\/[^?]+\?archived=only$/u);
  await page.reload();
  await expect(page.getByTestId('pane-meta')).toContainText('Archived');
  await expect(page.getByTestId('pane-status')).toHaveText('Canceled');
  await page.keyboard.press('Shift+E');
  await expect(page.getByText('Archived runs appear here.')).toBeVisible();
  await expect(outcome(page)).toHaveText('Unarchived');
  await page.getByRole('banner').getByRole('link', { name: 'Runs' }).click();
  await expect(row(page, spec.runId)).toContainText('Canceled');
});

test('moves back from implementation review and returns after a new build attempt', async ({ page, fakeServer }) => {
  const { runId } = await fakeServer.seed({ scenario: 'implementation-review' });
  await page.goto(`${fakeServer.baseUrl}/runs/${runId}`);
  await page.getByRole('tab', { name: 'Activity' }).click();
  await expect(attempt(page, 'implementation.human_review').last()).toContainText('Waiting on you');
  const build = attempt(page, 'implementation.build');
  const previousCount = await build.count();
  expect(previousCount).toBeGreaterThan(0);
  await page.keyboard.press('s');
  const dialog = page.getByRole('dialog', { name: 'Move the run back' });
  await expect(dialog.getByRole('button', { name: 'Move back' })).toBeDisabled();
  await dialog.getByRole('radio', { name: 'implementation.build', exact: true }).check();
  await dialog.getByRole('button', { name: 'Move back' }).click();
  await expect(outcome(page)).toHaveText('Moved back');
  await expect.poll(() => build.count()).toBeGreaterThan(previousCount);
  await expect(attempt(page, 'implementation.human_review').last()).toContainText('Waiting on you');
  await expect(page.getByTestId('pane-status')).toHaveText('Needs review');
});

test('renames a merged run without touching the issue link and persists the title', async ({ page, fakeServer }) => {
  const { runId } = await fakeServer.seed({ scenario: 'merged' });
  await page.goto(`${fakeServer.baseUrl}/runs/${runId}`);
  const link = page.getByTestId('pane-issue-link');
  const href = await link.getAttribute('href');
  const number = await link.textContent();
  await page.keyboard.press('n');
  const field = page.getByRole('textbox', { name: 'Run title' });
  await field.fill('  Release verification complete  ');
  await field.press('Enter');
  await expect(outcome(page)).toHaveText('Renamed');
  await expect(row(page, runId)).toContainText('Release verification complete');
  await expect(page.getByTestId('pane-run-title')).toHaveText('Release verification complete');
  await page.reload();
  await expect(page.getByTestId('pane-run-title')).toHaveText('Release verification complete');
  await expect(row(page, runId)).toContainText('Release verification complete');
  await expect(link).toHaveAttribute('href', href!);
  await expect(link).toHaveText(number!);
});
