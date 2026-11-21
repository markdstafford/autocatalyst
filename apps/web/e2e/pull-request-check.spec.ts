import type { Page } from '@playwright/test';

import { expect, test } from './fixtures/connected.js';
import type { SeedResult } from './fixtures/fake-server.js';

function observeChecks(page: Page, baseUrl: string): string[] {
  const checks: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    const match = /^\/v1\/runs\/([^/]+)\/pull-request\/refresh$/u.exec(url.pathname);
    if (url.origin === baseUrl && request.method() === 'POST' && match?.[1] !== undefined) {
      checks.push(decodeURIComponent(match[1]));
    }
  });
  return checks;
}

function row(page: Page, seed: SeedResult) {
  return page.locator(`[role="row"][data-run-id="${seed.runId}"]`);
}

function pullRequestNumber(seed: SeedResult): number {
  if (seed.pullRequestNumber === null) {
    throw new Error(`Seed for issue ${seed.issueNumber} did not open a pull request.`);
  }
  return seed.pullRequestNumber;
}

test('approves implementation from Acceptance and offers only a manual check at the PR gate', async ({
  browser, fakeServer, connectedStatePath
}) => {
  const implementation = await fakeServer.seed({ scenario: 'implementation-review' });
  const context = await browser.newContext({ storageState: connectedStatePath });
  try {
    const page = await context.newPage();
    const checks = observeChecks(page, fakeServer.baseUrl);
    await page.goto(`${fakeServer.baseUrl}/runs/${implementation.runId}`);
    await expect(page.getByTestId('pane-summary-step')).toHaveText('implementation.human_review');
    await page.getByRole('tab', { name: 'Acceptance' }).click();
    await expect(page.getByText('No testing guide for this run')).toBeVisible();
    await expect(page.getByText('A testing guide is not available here yet. Review the pull request to validate the change.')).toBeVisible();

    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    const confirm = page.getByRole('dialog', { name: 'Approve this implementation?' });
    const reply = page.waitForRequest((request) =>
      request.method() === 'POST' && request.url() === `${fakeServer.baseUrl}/v1/runs/${implementation.runId}/replies`
    );
    await confirm.getByRole('button', { name: 'Approve' }).click();
    expect((await reply).postDataJSON()).toEqual({ kind: 'approve' });
    await page.getByRole('tab', { name: 'Summary' }).click();
    await expect(page.getByTestId('pane-summary-step')).toHaveText('pr.human_review');
    await expect(page.getByTestId('pane-summary-pr')).toHaveText(/#\d+ · Open/u);
    await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Check now' })).toBeEnabled();
    expect(checks).toEqual([]);
    await page.getByRole('button', { name: 'Check now' }).click();
    await expect(page.getByText('Checked just now')).toBeVisible();
    expect(checks).toEqual([implementation.runId]);
  } finally {
    await context.close();
  }
});

test('checks on selection and on demand, stays idle, and applies a merge to the pane and list', async ({
  browser, fakeServer, connectedStatePath
}) => {
  const open = await fakeServer.seed({ scenario: 'pr-open' });
  const merged = await fakeServer.seed({ scenario: 'merged' });
  const context = await browser.newContext({ storageState: connectedStatePath });
  try {
    const page = await context.newPage();
    const checks = observeChecks(page, fakeServer.baseUrl);
    await page.goto(`${fakeServer.baseUrl}/runs/${merged.runId}`);
    const pr = page.getByTestId('pane-summary-pr');
    const status = page.getByTestId('pane-status');
    const check = page.getByRole('button', { name: 'Check now' });
    await expect(status).toHaveText('Done');
    await expect(pr).toHaveText(`#${pullRequestNumber(merged)} · Merged`);
    await expect(check).toHaveCount(0);
    expect(checks).toEqual([]);

    await row(page, open).click();
    await expect(status).toHaveText('Needs review');
    await expect(pr).toHaveText(`#${pullRequestNumber(open)} · Open`);
    await expect(page.getByText('Checked just now')).toBeVisible();
    expect(checks).toEqual([open.runId]);
    // Observe real network requests across two run-list poll intervals.
    await page.waitForTimeout(10_000);
    expect(checks).toEqual([open.runId]);

    await row(page, merged).click();
    await expect(pr).toHaveText(`#${pullRequestNumber(merged)} · Merged`);
    await row(page, open).click();
    await expect(page.getByText('Checked just now')).toBeVisible();
    expect(checks).toEqual([open.runId, open.runId]);

    const refreshUrl = `${fakeServer.baseUrl}/v1/runs/${open.runId}/pull-request/refresh`;
    const refreshedOpen = page.waitForResponse((response) => response.url() === refreshUrl && response.request().method() === 'POST');
    await check.click();
    expect((await refreshedOpen).status()).toBe(200);
    await expect(page.getByText('Checked just now')).toBeVisible();
    await expect(page.getByRole('status').locator('time')).toHaveAttribute('datetime', /^\d{4}-/u);
    await expect(pr).toContainText('Open');
    await expect(row(page, open).getByText('Needs review')).toBeVisible();
    await expect(status).toHaveText('Needs review');

    await fakeServer.writePullRequestState(pullRequestNumber(open), 'merged');
    await check.click();
    await expect(pr).toContainText('Merged');
    await expect(status).toHaveText('Done');
    await expect(row(page, open).getByText('Done')).toBeVisible();
    await expect(row(page, open).getByText('Needs review')).toHaveCount(0);
    await expect(check).toHaveCount(0);
    expect(checks).toEqual([open.runId, open.runId, open.runId, open.runId]);
  } finally {
    await context.close();
  }
});

test('shows Closed and Failed with a reason, and displays the prefailed seed without checking it', async ({
  browser, fakeServer, connectedStatePath
}) => {
  await fakeServer.seed({ scenario: 'pr-open' });
  const closing = await fakeServer.seed({ scenario: 'pr-open', issue: 9 });
  const prefailed = await fakeServer.seed({ scenario: 'failed' });
  const context = await browser.newContext({ storageState: connectedStatePath });
  try {
    const page = await context.newPage();
    const checks = observeChecks(page, fakeServer.baseUrl);
    await page.goto(`${fakeServer.baseUrl}/runs/${closing.runId}`);
    const pr = page.getByTestId('pane-summary-pr');
    const status = page.getByTestId('pane-status');
    const reason = page.getByTestId('pane-summary-failure');
    const check = page.getByRole('button', { name: 'Check now' });
    const approve = page.getByRole('button', { name: 'Approve', exact: true });
    await expect(pr).toHaveText(`#${pullRequestNumber(closing)} · Open`);
    await expect(page.getByText('Checked just now')).toBeVisible();
    expect(checks).toEqual([closing.runId]);

    await fakeServer.writePullRequestState(pullRequestNumber(closing), 'closed');
    await check.click();
    await expect(pr).toHaveText(`#${pullRequestNumber(closing)} · Closed`);
    await expect(status).toHaveText('Failed');
    await expect(row(page, closing).getByText('Failed')).toBeVisible();
    await expect(reason).toHaveText('The pull request was closed without merging.');
    await expect(approve).toHaveCount(0);
    await expect(check).toHaveCount(0);

    await row(page, prefailed).click();
    await expect(pr).toHaveText('—');
    await expect(status).toHaveText('Failed');
    const response = await context.request.get(`${fakeServer.baseUrl}/v1/runs/${prefailed.runId}`, {
      headers: { authorization: `Bearer ${fakeServer.bearerToken}` }
    });
    expect(response.ok()).toBe(true);
    const { failureReason } = await response.json() as { failureReason: string };
    expect(failureReason).toBeTruthy();
    await expect(reason).toHaveText(failureReason);
    await expect(approve).toHaveCount(0);
    await expect(check).toHaveCount(0);
    expect(checks).toEqual([closing.runId, closing.runId]);
  } finally {
    await context.close();
  }
});
