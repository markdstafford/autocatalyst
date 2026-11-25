import { createControlPlaneClient } from '@autocatalyst/sdk';
import type { Page } from '@playwright/test';

import { expect, test } from './fixtures/connected.js';

function row(page: Page, step: string, attempt?: number) {
  return page.getByRole('tabpanel').locator(`[data-activity-step="${step}"]${attempt === undefined ? '' : `[data-attempt-number="${attempt}"]`}`);
}

const scenarios = [
  { name: 'spec-review', fills: ['current', 'upcoming', 'upcoming'], wait: 'spec.human_review', step: 'spec.human_review',
    gates: ['spec.human_review', 'implementation.human_review', 'pr.human_review'],
    tail: ['implementation.plan', 'implementation.build', 'implementation.human_review', 'pr.finalize', 'pr.open', 'pr.human_review', 'done'] },
  { name: 'implementation-review', fills: ['done', 'current', 'upcoming'], wait: 'implementation.human_review', step: 'implementation.human_review',
    gates: ['spec.human_review', 'implementation.human_review', 'pr.human_review'], tail: ['pr.finalize', 'pr.open', 'pr.human_review', 'done'] },
  { name: 'pr-open', fills: ['done', 'done', 'current'], wait: 'pr.human_review', step: 'pr.human_review',
    gates: ['implementation.human_review', 'pr.human_review'], tail: ['done'] },
  { name: 'merged', fills: ['done', 'done'], wait: undefined, step: 'done',
    gates: ['implementation.human_review', 'pr.human_review'], tail: [] },
  { name: 'failed', fills: ['current', 'upcoming', 'upcoming'], wait: undefined, step: 'failed',
    gates: ['spec.human_review', 'implementation.human_review', 'pr.human_review'],
    tail: ['spec.human_review', 'implementation.plan', 'implementation.build', 'implementation.human_review', 'pr.finalize', 'pr.open', 'pr.human_review'] }
] as const;

test('shows the five seeded paths and their durable attempts', async ({ browser, fakeServer, connectedStatePath }) => {
  const context = await browser.newContext({ storageState: connectedStatePath });
  const page = await context.newPage();
  try {
    for (const scenario of scenarios) {
      const { runId } = await fakeServer.seed({ scenario: scenario.name });
      await page.goto(`${fakeServer.baseUrl}/runs/${runId}`);
      const progress = page.getByRole('group', { name: 'Run progress' });
      await expect(progress).toBeVisible();
      await expect(page.getByTestId('run-progress-step')).toContainText(scenario.step);
      await expect.poll(() => progress.locator('[data-phase-state]').evaluateAll(segments =>
        segments.map(segment => segment.getAttribute('data-phase-state')))).toEqual(scenario.fills);
      expect(await progress.locator('[data-gate-step]').evaluateAll(gates =>
        gates.map(gate => gate.getAttribute('data-gate-step')))).toEqual(scenario.gates);
      const waiting = progress.locator('[data-waiting="true"]');
      if (scenario.wait === undefined) await expect(waiting).toHaveCount(0);
      else await expect(waiting).toHaveAttribute('data-gate-step', scenario.wait);
      if (scenario.name === 'pr-open') await expect(progress.getByText('Triage', { exact: true })).toBeVisible();

      await page.getByRole('tab', { name: 'Activity' }).click();
      const attempts = page.getByRole('tabpanel').locator('[data-activity-step]');
      if (scenario.wait) {
        await expect(row(page, scenario.wait)).toContainText('Waiting on you');
        await expect(attempts.last()).toHaveAttribute('data-activity-step', 'done');
        await expect(attempts.last()).toContainText('Not started');
      } else {
        await expect(attempts.last()).toHaveAttribute('data-activity-state', scenario.step);
        await expect(attempts.last()).toHaveAttribute('data-activity-step', scenario.step);
      }
      expect(await attempts.filter({ hasText: 'Not started' }).evaluateAll(rows =>
        rows.map(item => item.getAttribute('data-activity-step')))).toEqual(scenario.tail);

      if (scenario.name === 'spec-review') {
        const author = row(page, 'spec.author');
        await expect(author).toContainText('Done');
        await author.getByRole('button').click();
        await expect(author.getByText('Assistant turn', { exact: false }).first()).toBeVisible();
        await expect(author.getByText(/Tool · invoke · started/).first()).toBeVisible();
        await expect(author.getByText(/Session progress 0 of 1/).first()).toBeVisible();
      }
      if (scenario.name === 'pr-open') {
        await expect(page.getByRole('heading', { name: 'Triage' })).toBeVisible();
        await expect(row(page, 'spec.author')).toContainText('Done');
        await expect(row(page, 'spec.human_review')).toHaveCount(0);
      }
      if (scenario.name === 'merged') await expect(row(page, 'spec.author')).toHaveCount(0);
      if (scenario.name === 'failed') await expect(row(page, 'spec.author')).toContainText('Failed');
    }
  } finally {
    await context.close();
  }
});

test('shows repeated visits after SDK feedback and follows a delayed launch without a reload', async ({
  browser, fakeServer, connectedStatePath
}) => {
  const client = createControlPlaneClient({ baseUrl: fakeServer.baseUrl, bearerToken: fakeServer.bearerToken });
  const { runId } = await fakeServer.seed({ scenario: 'spec-review' });
  const context = await browser.newContext({ storageState: connectedStatePath });
  const page = await context.newPage();
  try {
    await page.goto(`${fakeServer.baseUrl}/runs/${runId}`);
    await page.getByRole('tab', { name: 'Activity' }).click();
    await expect(row(page, 'spec.human_review', 1)).toContainText('Waiting on you');
    await client.replyToRun(runId, { kind: 'feedback', title: 'Revise the spec', body: 'Please request changes to the specification.' });
    await expect(row(page, 'spec.author', 2)).toContainText('Attempt 2');
    await expect(row(page, 'spec.human_review', 2)).toContainText('Waiting on you');
    await expect(row(page, 'spec.author', 1)).toContainText('Done');
    await expect(row(page, 'spec.human_review', 1)).toContainText('Done');

    const { projects } = await client.listProjects();
    const project = projects.find(project => project.displayName === 'Fixture app');
    expect(project).toBeDefined();
    await fakeServer.writeDelay(7, 'spec.author', 5_000);
    const { run: live } = await client.createConversationWithFirstRun({
      projectId: project!.id, identity: 'progress-browser',
      topic: { title: 'Follow issue 7 live' },
      submission: { kind: 'issue_reference', body: 'Work on issue 7', issue: { number: 7 } }
    });
    // Follow the returned run immediately; the collection polls only every five
    // seconds. There is no reload after the running attempt is observed.
    await page.goto(`${fakeServer.baseUrl}/runs/${live.id}`);
    await page.getByRole('tab', { name: 'Activity' }).click();
    const author = row(page, 'spec.author', 1);
    await expect(author).toHaveAttribute('data-activity-state', 'running');
    const elapsed = author.getByTestId('attempt-time');
    const initial = await elapsed.textContent();
    await expect(elapsed).not.toHaveText(initial ?? '');
    await expect(author.getByText(/Session progress [12] of 5/)).toHaveCount(2);
    await expect(author).toHaveAttribute('data-activity-state', 'running');
    await expect(author).toHaveAttribute('data-activity-state', 'done', { timeout: 15_000 });
    await expect(author.getByText(/implementer · round 1/)).toBeVisible();
    await expect(row(page, 'spec.human_review')).toContainText('Waiting on you');
  } finally {
    await context.close();
  }
});
