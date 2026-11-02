/**
 * Pure run-field helper tests: title fallback, status word, the waiting mapping for
 * every waitingOn value against in-progress and each ended status, and age units.
 */
import type { RunStatus, RunWaitingOn } from '@autocatalyst/api-contract';
import { describe, expect, it } from 'vitest';

import { CELL_DASH, formatAge, rowTitle, statusWord, waitingCell } from './run-fields.js';
import { makeRun } from './run-fixtures.js';

describe('rowTitle', () => {
  it('uses the tracked issue title and number when present', () => {
    const t = rowTitle(makeRun({ issueNumber: 42, issueTitle: 'Do the thing' }));
    expect(t).toEqual({ title: 'Do the thing', number: '#42', hasIssue: true });
  });

  it('falls back to the run id for both title and number when no issue exists', () => {
    const t = rowTitle(makeRun({ id: 'run-xyz', withIssue: false }));
    expect(t).toEqual({ title: 'run-xyz', number: 'run-xyz', hasIssue: false });
  });
});

describe('statusWord', () => {
  it('maps each status to a word', () => {
    expect(statusWord('in_progress')).toBe('In progress');
    expect(statusWord('done')).toBe('Done');
    expect(statusWord('failed')).toBe('Failed');
    expect(statusWord('canceled')).toBe('Canceled');
  });

  it('shows a dash when status is absent', () => {
    expect(statusWord(undefined)).toBe(CELL_DASH);
  });
});

describe('waitingCell', () => {
  const ENDED: RunStatus[] = ['done', 'failed', 'canceled'];
  const WAITING: RunWaitingOn[] = ['human', 'ai', 'system', 'none'];

  it('maps each waitingOn value for an in-progress run', () => {
    expect(waitingCell(makeRun({ status: 'in_progress', waitingOn: 'human' }))).toEqual({
      label: 'Waiting on you',
      primary: true
    });
    expect(waitingCell(makeRun({ status: 'in_progress', waitingOn: 'ai' }))).toEqual({
      label: 'Working',
      primary: false
    });
    expect(waitingCell(makeRun({ status: 'in_progress', waitingOn: 'system' }))).toEqual({
      label: 'Working',
      primary: false
    });
    const none = waitingCell(makeRun({ status: 'in_progress', waitingOn: 'none' }));
    expect(none.label).toBe(CELL_DASH);
    expect(none.primary).toBe(false);
    expect(none.tooltip).toMatch(/nothing is waiting/i);
  });

  it('shows a dash for every ended status regardless of waitingOn', () => {
    for (const status of ENDED) {
      for (const waitingOn of WAITING) {
        const cell = waitingCell(makeRun({ status, waitingOn, terminal: true }));
        expect(cell).toEqual({ label: CELL_DASH, primary: false });
      }
    }
  });
});

describe('formatAge', () => {
  const base = '2026-06-01T12:00:00.000Z';

  it('uses minutes under an hour', () => {
    expect(formatAge('2026-06-01T11:30:00.000Z', base)).toBe('30m');
    expect(formatAge('2026-06-01T11:59:30.000Z', base)).toBe('0m');
  });

  it('uses hours under a day', () => {
    expect(formatAge('2026-06-01T09:00:00.000Z', base)).toBe('3h');
  });

  it('uses days beyond a day', () => {
    expect(formatAge('2026-05-29T12:00:00.000Z', base)).toBe('3d');
  });

  it('clamps future timestamps to 0m and dashes unparseable input', () => {
    expect(formatAge('2026-06-01T13:00:00.000Z', base)).toBe('0m');
    expect(formatAge('not-a-date', base)).toBe(CELL_DASH);
  });
});
