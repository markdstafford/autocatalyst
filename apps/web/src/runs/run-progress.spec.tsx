import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { attempt, workflow } from './run-activity.test-helper.js';
import { makeRun } from './run-fixtures.js';
import { RunProgress } from './run-progress.js';
import { projectProgress } from './run-progress-projection.js';

it('renders arbitrary phase order, labels and compact-number tooltips with keyboard focus', async () => {
  const base = workflow();
  const options = { run: { ...makeRun(), currentStep: 'look' }, attempts: undefined };
  const extras = Array.from({ length: 5 }, (_, i) => ({ id: 'custom-' + i, label: 'Custom ' + i, steps: [] }));
  const user = userEvent.setup();
  const { rerender } = render(<RunProgress {...options} workflow={{ ...base,
    phases: [extras[1]!, base.phases[1]!, extras[0]!, base.phases[0]!] }} />);
  const bar = () => screen.getByRole('group', { name: 'Run progress' });
  const segments = () => within(bar()).getAllByRole('listitem');
  expect(segments().map(item => item.dataset['phaseState'])).toEqual(['done', 'done', 'done', 'current']);
  expect(segments().map(item => item.querySelector('[aria-hidden="true"]')?.textContent)).toEqual(['Custom 1', 'Ship', 'Custom 0', 'Prepare']);

  rerender(<RunProgress {...options} workflow={{ ...base, phases: [...extras, ...base.phases] }} />);
  expect(segments()).toHaveLength(7);
  expect(segments()[5]?.getAttribute('aria-current')).toBe('step');
  const numbered = within(segments()[0]!).getByText('1', { exact: true });
  const context = document.getElementById(bar().getAttribute('aria-describedby') ?? '');
  expect(context?.textContent).toContain('Phase 6 of 7, Prepare, step look.');
  await user.tab();
  expect(document.activeElement).toBe(numbered);
  expect(await screen.findByText('Custom 0', { exact: true, selector: '[data-base-ui-portal] div' })).toBeDefined();
  await user.unhover(numbered);
  await user.hover(within(segments()[1]!).getByText('2', { exact: true }));
  await screen.findByText('Custom 1', { exact: true, selector: '[data-base-ui-portal] div' });
  rerender(<RunProgress run={makeRun({ status: 'done' })} workflow={{ ...base, phases: [...extras, ...base.phases] }} attempts={undefined} />);
  expect(segments().map(segment => segment.querySelector('[tabindex="0"]')?.textContent))
    .toEqual(['1', '2', '3', '4', '5', '6', '7']);
  expect(segments().every(segment => segment.dataset['phaseState'] === 'done')).toBe(true);
});

it('places and describes only on-path gate rings', async () => {
  const user = userEvent.setup();
  render(<RunProgress run={{ ...makeRun(), currentStep: 'look' }} workflow={workflow()} attempts={undefined} />);
  const waiting = screen.getByRole('img', { name: 'look: Waiting on you' });
  const upcoming = screen.getByRole('img', { name: 'sign: Not waiting' });
  expect(waiting.style.left).toBe(`${5 / 6 * 100}%`);
  expect(upcoming.style.left).toBe('75%');
  expect(waiting.className).toContain('bg-text');
  expect(upcoming.className).not.toContain('bg-text');
  await user.tab();
  expect(document.activeElement).toBe(waiting);
  expect(await screen.findByText('look', { exact: true, selector: '[data-base-ui-portal] div' })).toBeDefined();
});

it('keeps the visible current step separate from the stop position and omits a zero-phase bar', () => {
  const definition = workflow();
  const history = [attempt('write', 0, 0, 2), attempt('assemble', 1, 2, 4)];
  const failed = { ...makeRun({ status: 'failed' }), currentStep: 'error-stop' };
  const { rerender } = render(<RunProgress run={failed} workflow={definition} attempts={history} />);
  expect(screen.getByText(/Stopped in phase 2 of 2, Ship, at assemble; current step error-stop/)).toBeDefined();
  expect(screen.getByTestId('run-progress-step').textContent).toBe('error-stop');
  for (const run of [failed, makeRun(), makeRun({ status: 'done' })]) {
    rerender(<RunProgress run={run} workflow={{ ...definition, phases: [] }} attempts={history} />);
    expect(screen.queryByRole('group', { name: 'Run progress' })).toBeNull();
    expect(screen.getByTestId('run-progress-step').textContent).toBe(run.currentStep);
  }
  rerender(<RunProgress run={failed} workflow={undefined} attempts={history} />);
  expect(screen.queryByRole('group', { name: 'Run progress' })).toBeNull();
});

it('uses phase-less history and terminal outcomes without inventing a current segment', () => {
  const steps = [attempt('write', 0, 0, 1), attempt('open', 1, 1, 2), attempt('abort-stop', 2, 2, null)];
  const base = workflow();
  const snapshot = { ...makeRun({ status: 'canceled' }), currentStep: 'abort-stop' };
  expect(projectProgress(snapshot, base, steps).segments.map(phase => phase.state)).toEqual(['done', 'upcoming']);
  expect(projectProgress({ ...makeRun(), currentStep: 'open' }, base, steps.slice(0, 1)).segments.map(phase => phase.state))
    .toEqual(['done', 'upcoming']);
  expect(projectProgress(makeRun({ status: 'done' }), base).segments.map(phase => phase.state)).toEqual(['done', 'done']);
  expect(projectProgress({ ...makeRun(), currentStep: 'pause' }, base).segments.map(phase => phase.state))
    .toEqual(['current', 'upcoming']);
});
