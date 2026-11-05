/**
 * Pure run-field helper tests: title fallback and age units.
 *
 * The status word/dot and the waiting-cell mapping that used to live here moved to the
 * shared `runStateChip` mapping; `run-state.spec.ts` covers every state combination,
 * including the no-status and missing-waitingOn cases.
 */
import { describe, expect, it } from 'vitest';

import { CELL_DASH, formatAge, rowTitle } from './run-fields.js';
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
