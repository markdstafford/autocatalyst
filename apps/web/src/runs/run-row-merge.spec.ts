/**
 * Row-merge freshness tests: the later-`updatedAt` rule used by both the poll merge and
 * `replaceRun`, including the equal-timestamp tie-break and the stale-poll non-revert.
 */
import { describe, expect, it } from 'vitest';

import { makeRun } from './run-fixtures.js';
import { isStrictlyNewer, mergeRunRows, replaceRunInRows } from './run-row-merge.js';

function runAt(id: string, updatedAt: string, currentStep = 'spec.author'): ReturnType<typeof makeRun> {
  return { ...makeRun({ id }), updatedAt, currentStep };
}

describe('isStrictlyNewer', () => {
  it('is true only when strictly later', () => {
    const base = runAt('r', '2026-01-01T00:00:01.000Z');
    expect(isStrictlyNewer(runAt('r', '2026-01-01T00:00:02.000Z'), base)).toBe(true);
    expect(isStrictlyNewer(runAt('r', '2026-01-01T00:00:01.000Z'), base)).toBe(false);
    expect(isStrictlyNewer(runAt('r', '2026-01-01T00:00:00.000Z'), base)).toBe(false);
  });
});

describe('mergeRunRows', () => {
  it('keeps the later-updatedAt row per id and follows incoming order', () => {
    const existing = [
      runAt('a', '2026-01-01T00:00:05.000Z', 'implementation.build'),
      runAt('b', '2026-01-01T00:00:01.000Z')
    ];
    // A poll that started earlier reports an older row for `a` and a newer row for `b`.
    const incoming = [
      runAt('b', '2026-01-01T00:00:09.000Z', 'pr.human_review'),
      runAt('a', '2026-01-01T00:00:02.000Z', 'spec.author')
    ];
    const merged = mergeRunRows(existing, incoming);
    expect(merged.map((r) => r.id)).toEqual(['b', 'a']); // incoming order
    // `a` keeps the newer existing row; `b` takes the newer incoming row.
    expect(merged[0]?.currentStep).toBe('pr.human_review');
    expect(merged[1]?.currentStep).toBe('implementation.build');
  });

  it('keeps the existing row on an equal timestamp', () => {
    const existing = [runAt('a', '2026-01-01T00:00:05.000Z', 'implementation.build')];
    const incoming = [runAt('a', '2026-01-01T00:00:05.000Z', 'spec.author')];
    const merged = mergeRunRows(existing, incoming);
    expect(merged[0]?.currentStep).toBe('implementation.build');
  });

  it('adds rows that are new to the collection', () => {
    const merged = mergeRunRows([runAt('a', '2026-01-01T00:00:01.000Z')], [
      runAt('a', '2026-01-01T00:00:01.000Z'),
      runAt('c', '2026-01-01T00:00:03.000Z')
    ]);
    expect(merged.map((r) => r.id)).toEqual(['a', 'c']);
  });
});

describe('replaceRunInRows', () => {
  it('advances the matching row when the incoming run is newer', () => {
    const rows = [runAt('a', '2026-01-01T00:00:01.000Z', 'spec.author'), runAt('b', '2026-01-01T00:00:01.000Z')];
    const next = replaceRunInRows(rows, runAt('a', '2026-01-01T00:00:09.000Z', 'spec.human_review'));
    expect(next).not.toBe(rows);
    expect(next[0]?.currentStep).toBe('spec.human_review');
    expect(next[1]).toBe(rows[1]); // untouched row keeps its identity
  });

  it('does not revert a row already advanced past the incoming run (stale response)', () => {
    const rows = [runAt('a', '2026-01-01T00:00:09.000Z', 'pr.human_review')];
    // A late getRun from a previous selection with an older timestamp must not win.
    const next = replaceRunInRows(rows, runAt('a', '2026-01-01T00:00:02.000Z', 'spec.author'));
    expect(next).toBe(rows); // unchanged reference
  });

  it('ignores a run not present in the rows', () => {
    const rows = [runAt('a', '2026-01-01T00:00:01.000Z')];
    expect(replaceRunInRows(rows, runAt('z', '2026-01-01T00:00:09.000Z'))).toBe(rows);
  });
});
