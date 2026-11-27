/// <reference lib="dom" />
import { createControlPlaneClient } from '@autocatalyst/sdk';
import type { Locator, Page } from '@playwright/test';

import { FIXTURE_TOKEN, expect, test } from './fixtures/connected.js';

const REPOSITORY = {
  displayName: 'Fixture app',
  repoUrl: 'https://github.com/autocatalyst-fixtures/demo-app',
  hostRepository: { provider: 'github', owner: 'autocatalyst-fixtures', name: 'demo-app' }
};
const PROJECTS = '/settings/projects';
const NEW = `${PROJECTS}/new`;
const setupPrompt = (page: Page) => page.getByRole('heading', { name: 'Add a project to get started' });
const save = (page: Page) => page.getByRole('button', { name: 'Save', exact: true });
const formStatus = (page: Page) => page.getByRole('main').getByRole('status');
const credential = (page: Page, group: string) => page.getByRole('group', { name: group, exact: true }).getByLabel(/^Credential/);

async function select(page: Page, label: string, choice: string): Promise<void> {
  await page.getByRole('combobox', { name: label }).click();
  await page.getByRole('option', { name: choice, exact: true }).click();
}

async function fillRepository(page: Page, url = REPOSITORY.repoUrl): Promise<void> {
  await page.getByLabel('Display name').fill(REPOSITORY.displayName);
  await page.getByLabel('Repository URL').fill(url);
  await select(page, 'Repository provider', 'GitHub');
  await page.getByLabel('Repository owner').fill(REPOSITORY.hostRepository.owner);
  await page.getByLabel('Repository name').fill(REPOSITORY.hostRepository.name);
}

test('sets up projects from an empty tenant and keeps credentials write-only through create and edit', async ({
  browser, fakeServer, connectedStatePath
}) => {
  const sdk = createControlPlaneClient({ baseUrl: fakeServer.baseUrl, bearerToken: FIXTURE_TOKEN });
  const unconnected = await browser.newContext();
  try {
    const page = await unconnected.newPage();
    await page.goto(`${fakeServer.baseUrl}/runs`);
    await expect(page.getByRole('heading', { name: 'Connect to the control plane' })).toBeVisible();
    await expect(setupPrompt(page)).toHaveCount(0);
    await page.getByRole('link', { name: 'Settings' }).click();
    await page.getByRole('link', { name: 'Projects' }).click();
    await expect(page.getByRole('button', { name: 'Open connection settings' })).toBeVisible();
  } finally {
    await unconnected.close();
  }

  const context = await browser.newContext({ storageState: connectedStatePath });
  try {
    const page = await context.newPage();
    const values = ['synthetic-issue-36b7', 'synthetic-host-b1a9', 'synthetic-replacement-2f71'];
    const containsValue = (text: string | null) => values.some((value) => text?.includes(value));
    let urlLeak = false;
    let consoleLeak = false;
    let responseLeak = false;
    let otherBodyLeak = false;
    let writes = 0;
    let secretWrites = 0;
    const uploads = values.map(() => 0);
    const responseChecks: Promise<void>[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (containsValue(request.url())) urlLeak = true;
      if (url.pathname.startsWith('/v1/projects') && ['POST', 'PATCH'].includes(request.method())) writes++;
      const body = request.postData();
      if (url.pathname === '/v1/secrets' && request.method() === 'POST') {
        secretWrites++;
        values.forEach((value, index) => {
          if (body === JSON.stringify({ value })) uploads[index] = (uploads[index] ?? 0) + 1;
        });
      } else if (containsValue(body)) otherBodyLeak = true;
    });
    page.on('console', (message) => { if (containsValue(message.text())) consoleLeak = true; });
    page.on('pageerror', (error) => { if (containsValue(error.message)) consoleLeak = true; });
    page.on('response', (response) => {
      if (new URL(response.url()).pathname.startsWith('/v1/') && response.headers()['content-type']?.includes('application/json')) {
        responseChecks.push(response.text().then((body) => { if (containsValue(body)) responseLeak = true; }));
      }
    });

    await page.goto(`${fakeServer.baseUrl}${PROJECTS}`);
    await expect(setupPrompt(page)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add project' })).toHaveCount(1);
    await page.getByRole('button', { name: 'Add project' }).click();
    await expect(page).toHaveURL(`${fakeServer.baseUrl}${NEW}`);
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('button', { name: 'Add project' })).toBeFocused();
    await page.getByRole('button', { name: 'Back', exact: true }).click();

    await expect(page).toHaveURL(`${fakeServer.baseUrl}/runs`);
    await expect(setupPrompt(page)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add project' })).toHaveCount(1);
    await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Runs' }).click();
    await page.getByRole('button', { name: 'Toggle sidebar' }).click();
    await expect(page.getByRole('button', { name: 'Projects', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Toggle sidebar' }).click();
    await page.getByRole('button', { name: 'Add project' }).click();

    await fillRepository(page, 'http://github.com/autocatalyst-fixtures/demo-app');
    await expect(page.getByLabel('Repository URL')).toHaveAccessibleDescription('Enter a valid HTTPS URL.');
    await expect(save(page)).toBeDisabled();
    expect(writes).toBe(0);
    await page.getByLabel('Repository URL').fill(REPOSITORY.repoUrl);
    await select(page, 'Issue tracker provider', 'GitHub');
    await select(page, 'Code host provider', 'GitHub');
    await page.getByLabel('Project key').fill('DEMO');
    await page.getByLabel('Issue tracker URL').fill('https://github.com');
    await page.getByLabel('Code host URL').fill('https://github.com');
    const issue = credential(page, 'Issue tracker');
    const host = credential(page, 'Code host');
    for (const field of [issue, host]) {
      await expect(field).toHaveAttribute('type', 'password');
      await expect(field).toHaveAttribute('autocomplete', 'off');
    }

    async function assertPrivateDom(): Promise<void> {
      const body = page.locator('body');
      const storage = await page.evaluate(() => JSON.stringify({
        local: Object.entries(localStorage), session: Object.entries(sessionStorage)
      }));
      expect(containsValue(await body.innerText()), 'credential in rendered text or toast').toBe(false);
      expect(containsValue(storage), 'credential in browser storage').toBe(false);
      // ARIA snapshots serialize password input values as well as names. Use
      // Chromium's computed names so a legitimate typed value is not a false leak.
      const cdp = await context.newCDPSession(page);
      try {
        const { nodes } = await cdp.send('Accessibility.getFullAXTree');
        const names = nodes.map((node) => String(node.name?.value ?? '')).join('\n');
        expect(containsValue(names), 'credential in accessible names').toBe(false);
      } finally {
        await cdp.detach();
      }
    }

    await issue.fill(values[0]!);
    await host.fill(values[1]!);
    await assertPrivateDom();
    await save(page).click();
    await expect(formStatus(page)).toHaveText('Saved');
    await expect(issue).toHaveValue('');
    await expect(host).toHaveValue('');
    expect(secretWrites).toBe(2);
    expect(writes).toBe(1);

    const { projects } = await sdk.listProjects();
    expect(projects).toHaveLength(1);
    const id = projects[0]!.id;
    const initial = await sdk.getProject(id);
    const issueRef = initial.issueTrackerSetting?.credentialRef;
    const hostRef = initial.codeHostSetting?.credentialRef;
    expect(issueRef?.id.startsWith('sec_')).toBe(true);
    expect(hostRef?.id.startsWith('sec_')).toBe(true);
    expect(containsValue(JSON.stringify([projects, initial]))).toBe(false);
    await expect(page).toHaveURL(`${fakeServer.baseUrl}${PROJECTS}/${id}`);
    await page.getByRole('button', { name: 'Back to runs' }).click();
    await expect(page).toHaveURL(`${fakeServer.baseUrl}/runs`);
    await expect(page.getByRole('heading', { name: 'No runs yet' })).toBeVisible();

    const primary = page.getByRole('navigation', { name: 'Primary' });
    const projectLink = (name: string) => primary.getByRole('link', { name, exact: true });
    await projectLink(REPOSITORY.displayName).click();
    await expect(page).toHaveURL(`${fakeServer.baseUrl}/runs?project=${id}`);
    await expect(page.getByRole('banner').getByRole('heading', { name: 'All runs' })).toBeVisible();
    await expect(page.getByRole('banner').getByText(REPOSITORY.displayName, { exact: true })).toBeVisible();
    await expect(projectLink(REPOSITORY.displayName)).not.toHaveAttribute('aria-current');
    await expect(primary.getByRole('link', { name: 'All runs' })).toHaveAttribute('aria-current', 'page');
    await page.getByRole('button', { name: 'Toggle sidebar' }).click();
    await page.getByRole('button', { name: 'Projects', exact: true }).press('Enter');
    await expect(projectLink(REPOSITORY.displayName)).toBeFocused();

    // Set existing reference labels via the public API so the blank edit proves
    // preservation of both labels as well as handles.
    const labelled = await sdk.updateProject(id, {
      issueTrackerSetting: { ...initial.issueTrackerSetting!, credentialRef: { ...issueRef!, label: 'Tracker access' } },
      codeHostSetting: { ...initial.codeHostSetting!, credentialRef: { ...hostRef!, label: 'Code access' } }
    });
    await primary.getByRole('link', { name: 'Settings' }).click();
    await page.getByRole('link', { name: 'Projects', exact: true }).click();
    await page.getByRole('main').getByRole('link', { name: /Fixture app.*demo-app/ }).click();
    await expect(issue).toHaveValue('');
    await expect(host).toHaveValue('');
    await page.getByLabel('Display name').fill('Renamed project');
    await save(page).click();
    await expect(formStatus(page)).toHaveText('Saved');
    const renamed = await sdk.getProject(id);
    expect(renamed.issueTrackerSetting?.credentialRef).toEqual(labelled.issueTrackerSetting?.credentialRef);
    expect(renamed.codeHostSetting?.credentialRef).toEqual(labelled.codeHostSetting?.credentialRef);
    expect(secretWrites).toBe(2);
    expect(writes).toBe(2);

    await host.fill(values[2]!);
    await assertPrivateDom();
    await save(page).click();
    await expect(formStatus(page)).toHaveText('Saved');
    await expect(host).toHaveValue('');
    const replaced = await sdk.getProject(id);
    expect(replaced.issueTrackerSetting?.credentialRef).toEqual(renamed.issueTrackerSetting?.credentialRef);
    expect(replaced.codeHostSetting?.credentialRef?.id).not.toBe(hostRef?.id);
    expect(replaced.codeHostSetting?.credentialRef?.purpose).toBe('code_host');
    expect(replaced.codeHostSetting?.credentialRef?.label).toBe(renamed.codeHostSetting?.credentialRef?.label);
    const rendered = await page.locator('body').evaluate((body) => body.outerHTML);
    for (const ref of [issueRef, hostRef, replaced.codeHostSetting?.credentialRef]) {
      expect(ref !== undefined && !rendered.includes(ref.id), 'no credential handles in rendered HTML').toBe(true);
    }
    expect(containsValue(JSON.stringify([labelled, renamed, replaced]))).toBe(false);
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByRole('main').getByRole('link', { name: /Renamed project.*demo-app/ })).toBeVisible();
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(projectLink('Renamed project')).toBeVisible();
    await expect(page.getByRole('banner').getByRole('heading', { name: 'All runs' })).toBeVisible();
    await expect(page.getByRole('banner').getByText('Renamed project', { exact: true })).toBeVisible();
    await primary.getByRole('link', { name: 'Runs', exact: true }).click();
    await expect(page).toHaveURL(`${fakeServer.baseUrl}/runs`);

    await assertPrivateDom();
    await Promise.all(responseChecks);
    expect([urlLeak, consoleLeak, responseLeak, otherBodyLeak]).toEqual([false, false, false, false]);
    expect(uploads).toEqual([1, 1, 1]);
    expect(secretWrites).toBe(3);
    expect(writes).toBe(3);
  } finally {
    await context.close();
  }
});

async function box(locator: Locator) {
  const result = await locator.boundingBox();
  if (result === null) throw new Error('Expected a visible layout box.');
  return result;
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`reports a duplicate and keeps save feedback above right-aligned actions (${colorScheme})`, async ({
    browser, fakeServer, connectedStatePath
  }) => {
    const sdk = createControlPlaneClient({ baseUrl: fakeServer.baseUrl, bearerToken: FIXTURE_TOKEN });
    await sdk.createProject(REPOSITORY);
    const context = await browser.newContext({
      storageState: connectedStatePath, colorScheme, viewport: { width: 1400, height: 1200 }
    });
    try {
      const page = await context.newPage();
      await page.goto(`${fakeServer.baseUrl}${NEW}`);
      await fillRepository(page);
      await save(page).click();
      await expect(formStatus(page)).toContainText('Failed: a project for this repository already exists');
      await expect(page.getByLabel('Repository owner')).toHaveAccessibleDescription('This repository already has a project.');
      const tokenWidth = await page.evaluate(() => {
        const probe = document.createElement('div');
        probe.style.width = 'var(--width-settings-column)';
        document.body.append(probe);
        const width = probe.getBoundingClientRect().width;
        probe.remove();
        return width;
      });
      const form = await box(page.locator('form'));
      const status = await box(formStatus(page));
      const cancel = await box(page.getByRole('button', { name: 'Cancel', exact: true }));
      const saveBox = await box(save(page));
      expect(Math.abs(form.width - tokenWidth)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(saveBox.x + saveBox.width - form.x - form.width)).toBeLessThanOrEqual(0.5);
      expect(status.y + status.height).toBeLessThanOrEqual(cancel.y);
      expect(status.y + status.height).toBeLessThanOrEqual(saveBox.y);
      expect(cancel.x + cancel.width).toBeLessThanOrEqual(saveBox.x);
      expect(Math.abs(cancel.y - saveBox.y)).toBeLessThanOrEqual(0.5);
    } finally {
      await context.close();
    }
  });
}
