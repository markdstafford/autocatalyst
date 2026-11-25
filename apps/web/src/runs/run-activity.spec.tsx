import { readFileSync } from 'node:fs';
import { deriveUsageTotals, type UsageGroup } from '@autocatalyst/api-contract';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { RunActivity } from './run-activity.js';
import { RunActivityBuffer } from './run-activity-buffer.js';
import { assistant, at, attempt, workflow } from './run-activity.test-helper.js';
import { makeRun, makeSession } from './run-fixtures.js';
import type { ActivityFacts } from './run-detail-facts.js';

afterEach(() => vi.useRealTimers());

function activity(steps: ActivityFacts['steps']): ActivityFacts {
  return { steps, workflow: { pending: false, value: workflow() }, buffer: new RunActivityBuffer(),
    connection: 'attached', replayGap: false };
}

function expectMarker(row: HTMLElement, label: string, icon: string, color: string) {
  expect(within(row).getByText(label, { exact: true })).toBeDefined();
  expect(row.querySelector(`svg.lucide-${icon}.${color}[width="14"][aria-hidden="true"]`)).not.toBeNull();
}

it('shows a running row by default, uses a single visible clock, and respects a manual collapse', () => {
  vi.useFakeTimers({ now: new Date(at(2)) });
  const run = { ...makeRun({ waitingOn: 'ai' }), currentStep: 'write' };
  const step = attempt('write', 0, 1, null);
  const facts = activity({ pending: false, value: [step] });
  const props = { run, activity: facts, sessions: { status: 'loading' } as const };
  const { rerender } = render(<RunActivity {...props} active />);
  const row = screen.getByRole('button', { name: /write Running/ });
  expectMarker(row, 'Running', 'loader-circle', 'text-primary');
  expect(within(row).getByText('write').classList.contains('font-mono')).toBe(true);
  expect(row.getAttribute('aria-expanded')).toBe('true');
  const time = within(row).getByTestId('attempt-time');
  expect(time.textContent).toBe('1s');
  expect(time.classList.contains('tabular-nums')).toBe(true);
  expect(row.querySelector('[class*="motion-safe:animate-spin"]')).not.toBeNull();
  expect(screen.getByText('No events yet')).toBeDefined();
  expect(vi.getTimerCount()).toBe(1);
  expect(screen.queryByRole('status')).toBeNull();

  facts.buffer.add(assistant('html', 2, 'write', '<img src=x onerror=alert(1)>\nnot shown'), [step]);
  act(() => { vi.advanceTimersByTime(2_000); });
  expect(screen.getByText('<img src=x onerror=alert(1)>', { exact: false })).toBeDefined();
  expect(screen.queryByRole('img')).toBeNull();
  expect(screen.queryByText('not shown')).toBeNull();
  expect(screen.getByTestId('last-event').textContent).toBe('Last event 2s ago');
  expect(within(row).getByTestId('attempt-time').textContent).toBe('3s');
  fireEvent.click(row);
  rerender(<RunActivity {...props} active={false} />);
  expect(vi.getTimerCount()).toBe(0);
  rerender(<RunActivity {...props} active />);
  expect(row.getAttribute('aria-expanded')).toBe('false');
});

it('renders historical stops neutrally and shows expandable Ended attempts and unvisited placeholders', async () => {
  const run = { ...makeRun(), currentStep: 'look' };
  const steps = [attempt('write', 0, 0, 1), attempt('error-stop', 1, 1, null), attempt('look', 2, 2, null, 2)];
  const facts = activity({ pending: false, value: steps });
  const { container } = render(<RunActivity run={run} activity={facts} sessions={{ status: 'success', value: [] }} active />);
  const ended = screen.getByRole('button', { name: /write Ended/ });
  const oldStop = container.querySelector('[data-activity-state="historical-stop"]');
  for (const item of [ended, oldStop]) {
    expect(item?.querySelector('svg.text-overlay.lucide-square[width="14"]')).not.toBeNull();
    expect(item?.closest('li')?.className).not.toContain('opacity');
  }
  expect(oldStop?.querySelector('.font-mono')?.textContent).toBe('error-stop');
  expect(oldStop?.querySelector('button')).toBeNull();
  const waiting = screen.getByRole('button', { name: 'look Attempt 2 Waiting on you' });
  expectMarker(waiting, 'Waiting on you', 'hand', 'text-primary');
  expect(within(waiting).getByText('Attempt 2', { exact: true })).toBeDefined();
  ended.focus();
  await userEvent.keyboard('{Enter}');
  expect(screen.getByText('Sessions')).toBeDefined();
  expect(screen.getByText('Events')).toBeDefined();
  const skipped = screen.getByText('draft', { exact: true }).closest('li')!;
  const unreached = screen.getByText('finish', { exact: true }).closest('li')!;
  expectMarker(skipped, 'Skipped', 'circle-minus', 'text-overlay');
  expectMarker(unreached, 'Not started', 'circle', 'text-overlay');
  for (const row of [skipped, unreached]) {
    expect(row.classList.contains('opacity-60')).toBe(true);
    expect(row.querySelector('button, [data-testid="attempt-time"]')).toBeNull();
  }
});

it.each([
  { status: 'failed', terminalStep: 'error-stop', label: 'Failed', color: 'text-red' },
  { status: 'canceled', terminalStep: 'abort-stop', label: 'Canceled', color: 'text-overlay' }
] as const)('renders the $label marker on both the stopped attempt and terminal row', ({ status, terminalStep, label, color }) => {
  const run = { ...makeRun({ status, waitingOn: 'none' }), currentStep: terminalStep };
  const steps = [attempt('write', 0, 0, 1), attempt(terminalStep, 1, 1, null)];
  render(<RunActivity run={run} activity={activity({ pending: false, value: steps })}
    sessions={{ status: 'success', value: [] }} active />);

  const stopped = screen.getByRole('button', { name: `write ${label}` });
  const terminal = screen.getByText(terminalStep, { exact: true }).closest('li')!;
  expectMarker(stopped, label, 'circle-x', color);
  expectMarker(terminal, label, 'circle-x', color);
  expect(stopped.closest('li')?.className).not.toContain('opacity');
  expect(terminal.className).not.toContain('opacity');
  expect(within(terminal).queryByRole('button')).toBeNull();
});

it('keeps independent errors and recordings visible, distinguishing incomplete, zero and unknown pricing', () => {
  const run = { ...makeRun(), currentStep: 'look' };
  const steps = [attempt('write', 0, 0, 120), attempt('look', 1, 120, null)];
  const facts: ActivityFacts = { ...activity({ pending: false, value: steps, error: 'steps down' }),
    replayGap: true, workflow: { pending: false, error: 'workflow down' } };
  const unpriced = { ...makeSession({ id: 'unknown' }), step: 'write' };
  const priced = { ...makeSession({ id: 'priced', sequence: 2 }), step: 'write', cost: {
    ...unpriced.cost, usd: 0, basis: 'api_list_price' as const, complete: false, rateVersionIds: [], gaps: []
  } };
  const model = { provider: 'anthropic', model: 'review-model' } as const;
  const group: UsageGroup = {
    model,
    requestInputTokens: 1_149,
    tokens: { freshInput: 900, cacheRead: 249, cacheWrite: 'not_applicable', output: 100, reasoningOutput: 80 }
  };
  const known = {
    ...makeSession({
      id: 'known', sequence: 3, outcome: 'failed', durationMs: 90_000,
      usage: { coverage: 'complete', groups: [group], totals: deriveUsageTotals([group], 'complete') }
    }),
    step: 'write', role: 'reviewer' as const, round: 2, model, endedAt: at(90),
    cost: { ...priced.cost, model, usd: 300_000_001, complete: true, rateVersionIds: ['rate-1'] }
  };
  const { container, rerender } = render(<RunActivity run={run} activity={facts}
    sessions={{ status: 'error', message: 'sessions down', value: [unpriced, priced, known] }} active />);
  const done = screen.getByRole('button', { name: 'write Done' });
  expectMarker(done, 'Done', 'circle-check', 'text-green');
  expect(screen.queryByRole('heading', { name: 'Sessions' })).toBeNull();
  fireEvent.click(done);
  for (const text of ['steps down', 'workflow down', 'sessions down', 'Some events may be missing']) {
    expect(screen.getByText(text, { exact: false })).toBeDefined();
  }
  const sessions = screen.getByRole('heading', { name: 'Sessions' }).parentElement!;
  expect(within(sessions).getAllByRole('listitem').map(row => row.textContent)).toEqual([
    'implementer · round 0 · claude-opus-4 · 1s · Tokens: 165 · Legacy · Unknown API list price · succeeded',
    'implementer · round 0 · claude-opus-4 · 1s · Tokens: 165 · Legacy · $0.00 API list price · Incomplete · succeeded',
    'reviewer · round 2 · review-model · 1m 30s · Tokens: 1.2K · $0.300000001 API list price · failed'
  ]);
  expect(container.querySelector('[data-activity-state="unreached"]')).toBeNull();
  expect(screen.queryByRole('heading', { name: 'Prepare' })).toBeNull();
  expect(screen.queryByText('Earlier events are not shown')).toBeNull();
  rerender(<RunActivity run={run} activity={activity({ pending: true })} sessions={{ status: 'loading' }} active />);
  expect(screen.getByText('Loading attempts…')).toBeDefined();
  expect(screen.queryByText('No recorded attempts.')).toBeNull();
  rerender(<RunActivity run={run} activity={activity({ pending: false, value: [] })} sessions={{ status: 'loading' }} active />);
  expect(screen.getByText('No recorded attempts.')).toBeDefined();
});

it('does not encode catalog step or phase IDs in new renderer, projection or event modules', () => {
  const catalog = readFileSync('../../packages/core/src/run-step-catalog.ts', 'utf8');
  const stepIds = [...catalog.matchAll(/\bid: '([^']+)'/gu)].map(match => match[1]);
  const phaseIds = [...catalog.matchAll(/\bphase: '([^']+)'/gu)].map(match => match[1]);
  expect(stepIds.length).toBeGreaterThan(5);
  expect(phaseIds.length).toBeGreaterThan(2);
  for (const name of ['run-progress.tsx', 'run-progress-projection.ts', 'run-activity.tsx', 'run-activity-path.ts',
    'run-activity-buffer.ts', 'run-activity-event-text.ts']) {
    const module = readFileSync('src/runs/' + name, 'utf8');
    // Status literals may overlap terminal step IDs; they must only compare to
    // Run.status, not step identifiers or phase IDs.
    for (const id of new Set([...stepIds, ...phaseIds].filter(id => !['done', 'failed', 'canceled'].includes(id ?? '')))) {
      expect(module, name).not.toContain(`'${id}'`);
      expect(module, name).not.toContain(`"${id}"`);
    }
  }
});
