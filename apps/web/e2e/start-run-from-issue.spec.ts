import { createControlPlaneClient } from '@autocatalyst/sdk';
import type { Locator, Page } from '@playwright/test';

import { expect, test, type FakeServer } from './fixtures/fake-server.js';
import { selectAndComment } from './fixtures/spec-comment.js';

const FIXTURE_PROJECT = 'Fixture app';
const PASSAGE = 'A. Names must be unique within a tenant.';
const EDGE_TOLERANCE = 0.5;

const modal = (page: Page) => page.getByRole('dialog', { name: 'Start a run' });
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Primary' });
const sidebarStart = (page: Page) => sidebar(page).getByRole('button', { name: 'Start a run' });
const start = (page: Page) => modal(page).getByRole('button', { name: 'Start run', exact: true });

function sdkFor(server: FakeServer) {
  return createControlPlaneClient({ baseUrl: server.baseUrl, bearerToken: server.bearerToken });
}

async function select(scope: Page | Locator, label: string, option: string): Promise<void> {
  await scope.getByRole('combobox', { name: label, exact: true }).click();
  // The Select listbox is portaled.
  const page = 'page' in scope ? scope.page() : scope;
  await page.getByRole('option', { name: option, exact: true }).click();
}

async function createProject(page: Page, displayName: string, name: string, hasTracker: boolean): Promise<void> {
  await page.getByLabel('Display name').fill(displayName);
  await page.getByLabel('Repository URL').fill('https://github.com/autocatalyst-fixtures/' + name);
  await select(page, 'Repository provider', 'GitHub');
  await page.getByLabel('Repository owner').fill('autocatalyst-fixtures');
  await page.getByLabel('Repository name').fill(name);
  if (hasTracker) {
    await select(page, 'Issue tracker provider', 'GitHub');
    await page.getByRole('group', { name: 'Issue tracker', exact: true }).getByLabel(/^Credential/).fill('fake-token');
  }
  await select(page, 'Code host provider', 'GitHub');
  await page.getByRole('group', { name: 'Code host', exact: true }).getByLabel(/^Credential/).fill('fake-token');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('main').getByRole('status')).toHaveText('Saved');
  await expect(page).not.toHaveURL(/\/settings\/projects\/new$/u);
}

async function connectAndConfigure(page: Page, server: FakeServer): Promise<void> {
  await page.goto(server.baseUrl + '/runs');
  await sidebarStart(page).click();
  await expect(modal(page).getByRole('heading', { name: 'Connect to the control plane' })).toBeVisible();
  await modal(page).getByRole('button', { name: 'Open connection settings' }).click();
  await expect(page).toHaveURL(server.baseUrl + '/settings/connection');
  const token = page.getByLabel('Bearer token');
  await token.fill(server.bearerToken);
  await token.press('Enter');
  await expect(page.getByText('Connected', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await sidebarStart(page).click();
  await expect(modal(page).getByText('Add a project to get started')).toBeVisible();
  await modal(page).getByRole('button', { name: 'Add project' }).click();
  await expect(page).toHaveURL(server.baseUrl + '/settings/projects/new');
  await createProject(page, FIXTURE_PROJECT, 'demo-app', true);
  await page.getByRole('button', { name: 'Back to runs' }).click();
  await expect(page.getByRole('heading', { name: 'No runs yet' })).toBeVisible();
}

async function assertGeometry(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await expect(page.locator('html')).toHaveAttribute('data-theme-mode', theme);
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const dialog = (await modal(page).boundingBox())!;
  expect(Math.abs(dialog.x + dialog.width / 2 - viewport.width / 2)).toBeLessThanOrEqual(EDGE_TOLERANCE);
  expect(Math.abs(dialog.y + dialog.height / 2 - viewport.height / 2)).toBeLessThanOrEqual(EDGE_TOLERANCE);
  const backing = page.getByTestId('start-run-dialog-backdrop');
  const backdrop = (await backing.boundingBox())!;
  expect(Math.abs(backdrop.x)).toBeLessThanOrEqual(EDGE_TOLERANCE);
  expect(Math.abs(backdrop.y)).toBeLessThanOrEqual(EDGE_TOLERANCE);
  expect(Math.abs(backdrop.width - viewport.width)).toBeLessThanOrEqual(EDGE_TOLERANCE);
  expect(Math.abs(backdrop.height - viewport.height)).toBeLessThanOrEqual(EDGE_TOLERANCE);
  expect(await backing.evaluate((el) => el === document.elementFromPoint(innerWidth - 1, innerHeight - 1))).toBe(true);

  const actions = (await page.getByTestId('start-run-actions').boundingBox())!;
  const cancel = (await modal(page).getByRole('button', { name: 'Cancel' }).boundingBox())!;
  const submit = (await start(page).boundingBox())!;
  expect(cancel.x + cancel.width).toBeLessThan(submit.x);
  expect(Math.abs(cancel.y - submit.y)).toBeLessThanOrEqual(EDGE_TOLERANCE);
  expect(Math.abs(actions.x + actions.width - submit.x - submit.width)).toBeLessThanOrEqual(EDGE_TOLERANCE);
}

async function selectedRun(page: Page): Promise<string> {
  const row = page.getByRole('grid', { name: 'Runs' }).locator('[aria-selected=true]');
  await expect(row).toBeVisible();
  const id = await row.getAttribute('data-run-id');
  expect(id).toBeTruthy();
  await expect(page).toHaveURL(new RegExp('/runs/' + id + '$', 'u'));
  return id!;
}

test('starts an unseeded feature, revises and approves it, and finishes at merge', async ({ page, fakeServer }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await connectAndConfigure(page, fakeServer);
  await sidebarStart(page).click();
  await assertGeometry(page, 'light');
  await expect(modal(page).getByRole('combobox', { name: 'Project' })).toHaveText(FIXTURE_PROJECT);
  await modal(page).getByLabel('Issue reference').fill('#5');
  await expect(modal(page).getByText('Needs a work kind')).toBeVisible();
  const issue = modal(page).getByRole('region', { name: 'Issue preview' });
  await expect(issue).toContainText('#5');
  const title = await issue.locator('p').innerText();
  await expect(start(page)).toBeDisabled();
  await select(modal(page), 'Work kind', 'feature');
  expect(await fakeServer.readLaunchCount()).toBe(0);
  await start(page).click();
  await expect(modal(page)).toBeHidden();
  const id = await selectedRun(page);
  await expect(page.getByTestId('pane-run-title')).toHaveText(title);

  const spec = page.getByTestId('spec-gate-decision');
  await expect(spec).toHaveText('Approve');
  const initialSpecLaunches = await fakeServer.readLaunchCount();
  expect(initialSpecLaunches).toBe(2);
  const sdk = sdkFor(fakeServer);
  expect((await sdk.listRunSessions(id)).sessions.map(session => session.role)).toEqual(['implementer', 'reviewer']);
  await page.getByRole('tab', { name: 'Spec' }).click();
  await expect(page.getByTestId('spec-document')).toContainText(PASSAGE);
  await selectAndComment(page, PASSAGE, 'Clarify uniqueness scope.');
  await expect(spec).toHaveText('Request changes (1)');
  await spec.click();
  await page.getByTestId('spec-gate-decision-confirm').click();
  const card = page.locator('[data-card-for]').filter({ hasText: PASSAGE });
  await expect(card.getByTestId('status-chip')).toHaveText('addressed', { timeout: 20_000 });
  await expect(spec).toHaveText('Approve');
  const revisedSpecLaunches = await fakeServer.readLaunchCount();
  expect(revisedSpecLaunches).toBe(initialSpecLaunches + 2);
  expect((await sdk.listRunSessions(id)).sessions.filter(session => session.step === 'spec.author').map(session => session.role))
    .toEqual(['implementer', 'reviewer', 'implementer', 'reviewer']);
  await spec.click();
  await expect(page.getByTestId('spec-gate-decision-copy')).toContainText(/confirm.*addressed comment/iu);
  await page.getByTestId('spec-gate-decision-confirm').click();

  const implementation = page.getByTestId('implementation-gate-decision');
  await expect(implementation).toHaveText('Approve', { timeout: 20_000 });
  const implementationLaunches = await fakeServer.readLaunchCount();
  expect(implementationLaunches).toBeGreaterThan(revisedSpecLaunches);
  await page.getByRole('tab', { name: 'Acceptance' }).click();
  await expect(page.getByText('No testing guide for this run')).toBeVisible();
  await implementation.click();
  await page.getByTestId('implementation-gate-decision-confirm').click();
  await page.getByRole('tab', { name: 'Summary' }).click();

  const pr = page.getByTestId('pane-summary-pr');
  const check = page.getByRole('button', { name: 'Check now' });
  await expect(pr).toHaveText(/#\d+ · Open/u, { timeout: 20_000 });
  const firstCheck = page.waitForResponse((response) =>
    response.url().endsWith('/v1/runs/' + id + '/pull-request/refresh') && response.request().method() === 'POST');
  await check.click();
  expect((await firstCheck).ok()).toBe(true);
  await expect(page.getByText('Checked just now')).toBeVisible();
  await expect(pr).toContainText('Open');
  const number = Number(/#(\d+)/u.exec(await pr.innerText())?.[1]);
  expect(number).toBeGreaterThan(0);
  await fakeServer.writePullRequestState(number, 'merged');
  await check.click();
  await expect(pr).toHaveText('#' + number + ' · Merged');
  await expect(page.getByTestId('pane-status')).toHaveText('Done');

  expect(await sdk.getRun(id)).toMatchObject({ status: 'done', workKind: 'feature' });
  const { sessions } = await sdk.listRunSessions(id);
  expect(sessions.map((session) => session.step)).toEqual(expect.arrayContaining(['spec.author', 'implementation.build', 'pr.finalize']));
  expect(await fakeServer.readLaunchCount()).toBe(sessions.length);
  expect(sessions.length).toBeGreaterThan(implementationLaunches);
});

test('focuses a newly selected row from the empty state and shows scripted failure', async ({ page, fakeServer }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await connectAndConfigure(page, fakeServer);
  await fakeServer.writeFailure(8, 'spec.author');
  const opener = page.getByRole('main').getByRole('button', { name: 'Start a run' });
  await opener.click();
  await assertGeometry(page, 'dark');
  await modal(page).getByLabel('Issue reference').fill('8');
  await expect(modal(page).getByRole('combobox', { name: 'Work kind' })).toHaveText('enhancement');
  await start(page).click();
  const id = await selectedRun(page);
  await expect(page.getByTestId('run-row-' + id)).toBeFocused();
  await expect(page.getByTestId('pane-status')).toHaveText('Failed');
  const run = await sdkFor(fakeServer).getRun(id);
  expect(run).toMatchObject({ status: 'failed', workKind: 'enhancement', trackedIssue: { number: 8 } });
  expect(run.failureReason).toBeTruthy();
  await expect(page.getByTestId('pane-summary-failure')).toHaveText(run.failureReason!);
  expect(await fakeServer.readLaunchCount()).toBe(1);
});

test('opens the affected edit form when a second project has no tracker', async ({ page, fakeServer }) => {
  await connectAndConfigure(page, fakeServer);
  await sidebar(page).getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('link', { name: 'Projects' }).click();
  await page.getByRole('button', { name: 'Add project' }).click();
  await createProject(page, 'No tracker', 'no-tracker', false);
  const editUrl = page.url();
  expect(editUrl).not.toMatch(/\/new$/u);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await sidebarStart(page).click();
  await expect(modal(page).getByLabel('Issue reference')).toBeDisabled();
  await select(modal(page), 'Project', 'No tracker');
  await modal(page).getByLabel('Issue reference').fill('5');
  await expect(modal(page).getByText('This project has no issue tracker.')).toBeVisible();
  await expect(start(page)).toBeDisabled();
  await modal(page).getByRole('button', { name: 'Open project settings' }).click();
  await expect(page).toHaveURL(editUrl);
  await expect(page.getByLabel('Display name')).toHaveValue('No tracker');
  expect(await fakeServer.readLaunchCount()).toBe(0);
});
