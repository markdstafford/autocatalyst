/**
 * StatusChip tests: the correct label/tone for each run state, no chip for a missing
 * status (the caller renders the dash), and the design-system rule that `Needs review`
 * is the only filled (primary) chip.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { makeRun } from './run-fixtures.js';
import { StatusChip } from './status-chip.js';

describe('StatusChip', () => {
  it('renders the correct label for each run state', () => {
    const cases: Array<{ run: Parameters<typeof makeRun>[0]; label: string }> = [
      { run: { status: 'in_progress', waitingOn: 'human' }, label: 'Needs review' },
      { run: { status: 'in_progress', waitingOn: 'ai' }, label: 'Working' },
      { run: { status: 'in_progress', waitingOn: 'system' }, label: 'Working' },
      { run: { status: 'in_progress', waitingOn: 'none' }, label: 'Paused' },
      { run: { status: 'done', terminal: true }, label: 'Done' },
      { run: { status: 'failed', terminal: true }, label: 'Failed' },
      { run: { status: 'canceled', terminal: true }, label: 'Canceled' }
    ];
    for (const { run, label } of cases) {
      const { unmount } = render(<StatusChip run={makeRun(run)} data-testid="chip" />);
      expect(screen.getByTestId('chip').textContent).toBe(label);
      unmount();
    }
  });

  it('renders no chip for a missing status so the caller can render a dash', () => {
    const run = makeRun({ status: 'in_progress' });
    const { status: _drop, ...withoutStatus } = run;
    void _drop;
    const { container } = render(<StatusChip run={{ ...withoutStatus }} data-testid="chip" />);
    expect(screen.queryByTestId('chip')).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it('fills only the Needs review chip and leaves every other state unfilled', () => {
    const filledCases = [
      { run: makeRun({ status: 'in_progress', waitingOn: 'human' }), filled: true },
      { run: makeRun({ status: 'in_progress', waitingOn: 'ai' }), filled: false },
      { run: makeRun({ status: 'in_progress', waitingOn: 'none' }), filled: false },
      { run: makeRun({ status: 'done', terminal: true }), filled: false },
      { run: makeRun({ status: 'failed', terminal: true }), filled: false },
      { run: makeRun({ status: 'canceled', terminal: true }), filled: false }
    ];
    for (const { run, filled } of filledCases) {
      const { unmount } = render(<StatusChip run={run} data-testid="chip" />);
      const chip = screen.getByTestId('chip');
      // The filled (primary) chip carries the `bg-primary` fill class; outlined chips do not.
      expect(chip.className.includes('bg-primary')).toBe(filled);
      unmount();
    }
  });
});
