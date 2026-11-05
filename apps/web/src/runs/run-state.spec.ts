/**
 * Shared run-state mapping tests: every row of the status chip table, including the
 * defensive `Paused` state (in-progress with `none`/missing `waitingOn`) and the
 * no-status case that renders no chip.
 */
import type { RunWaitingOn } from '@autocatalyst/api-contract';
import { describe, expect, it } from 'vitest';

import { runStateChip } from './run-state.js';
import { makeRun } from './run-fixtures.js';

describe('runStateChip', () => {
  it('maps an in-progress human-waiting run to the only filled primary chip', () => {
    expect(runStateChip(makeRun({ status: 'in_progress', waitingOn: 'human' }))).toEqual({
      label: 'Needs review',
      tone: 'primary',
      filled: true
    });
  });

  it('maps ai and system waiting to a muted Working chip', () => {
    for (const waitingOn of ['ai', 'system'] as const) {
      expect(runStateChip(makeRun({ status: 'in_progress', waitingOn }))).toEqual({
        label: 'Working',
        tone: 'muted',
        filled: false
      });
    }
  });

  it('maps in-progress with none or missing waitingOn to the defensive Paused chip', () => {
    expect(runStateChip(makeRun({ status: 'in_progress', waitingOn: 'none' }))).toEqual({
      label: 'Paused',
      tone: 'muted',
      filled: false
    });
    // A malformed in-progress run with no waitingOn at all still maps to Paused.
    const run = makeRun({ status: 'in_progress', waitingOn: 'human' });
    const { waitingOn: _drop, ...withoutWaiting } = run;
    void _drop;
    expect(runStateChip({ ...withoutWaiting })).toEqual({
      label: 'Paused',
      tone: 'muted',
      filled: false
    });
  });

  it('maps terminal statuses regardless of waitingOn', () => {
    const WAITING: RunWaitingOn[] = ['human', 'ai', 'system', 'none'];
    for (const waitingOn of WAITING) {
      expect(runStateChip(makeRun({ status: 'done', waitingOn, terminal: true }))).toEqual({
        label: 'Done',
        tone: 'green',
        filled: false
      });
      expect(runStateChip(makeRun({ status: 'failed', waitingOn, terminal: true }))).toEqual({
        label: 'Failed',
        tone: 'red',
        filled: false
      });
      expect(runStateChip(makeRun({ status: 'canceled', waitingOn, terminal: true }))).toEqual({
        label: 'Canceled',
        tone: 'muted',
        filled: false
      });
    }
  });

  it('returns no chip descriptor when status is absent so callers render a dash', () => {
    const run = makeRun({ status: 'in_progress' });
    const { status: _drop, ...withoutStatus } = run;
    void _drop;
    expect(runStateChip({ ...withoutStatus })).toBeNull();
  });
});
