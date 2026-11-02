/**
 * Selection/collection helper tests: dedupe, initial route selection, vanished-row
 * reconciliation (both the following-row and previous-row cases), bounded keyboard
 * movement, and end-of-list detection.
 */
import { describe, expect, it } from 'vitest';

import { makeRun } from './run-fixtures.js';
import {
  dedupeRuns,
  isSelectionAtEnd,
  moveSelection,
  reconcileSelection,
  resolveInitialSelection
} from './run-list-selection.js';

describe('dedupeRuns', () => {
  it('keeps the first occurrence of each id', () => {
    const runs = [makeRun({ id: 'a' }), makeRun({ id: 'b' }), makeRun({ id: 'a' })];
    expect(dedupeRuns(runs).map((r) => r.id)).toEqual(['a', 'b']);
  });
});

describe('resolveInitialSelection', () => {
  it('honors a present route id', () => {
    expect(resolveInitialSelection(['a', 'b', 'c'], 'b')).toBe('b');
  });

  it('falls back to the first row for a missing route id', () => {
    expect(resolveInitialSelection(['a', 'b'], 'zzz')).toBe('a');
  });

  it('falls back to the first row with no route id', () => {
    expect(resolveInitialSelection(['a', 'b'], undefined)).toBe('a');
  });

  it('selects nothing for an empty collection', () => {
    expect(resolveInitialSelection([], 'a')).toBeUndefined();
  });
});

describe('reconcileSelection', () => {
  it('keeps a still-present selection', () => {
    expect(reconcileSelection(['a', 'b', 'c'], ['x', 'b', 'c'], 'b')).toBe('b');
  });

  it('selects the following row when the selected row vanished mid-list', () => {
    // 'b' removed at index 1; the row now at index 1 is 'c'.
    expect(reconcileSelection(['a', 'b', 'c'], ['a', 'c'], 'b')).toBe('c');
  });

  it('selects the previous row when the removed row had been last', () => {
    // 'c' removed; it was last, so clamp to the new last row 'b'.
    expect(reconcileSelection(['a', 'b', 'c'], ['a', 'b'], 'c')).toBe('b');
  });

  it('clears selection for an empty collection', () => {
    expect(reconcileSelection(['a'], [], 'a')).toBeUndefined();
  });

  it('selects the first row when the prior index is unknown', () => {
    expect(reconcileSelection([], ['a', 'b'], 'missing')).toBe('a');
  });
});

describe('moveSelection', () => {
  it('moves to the next and previous rows', () => {
    expect(moveSelection(['a', 'b', 'c'], 'b', 'next')).toBe('c');
    expect(moveSelection(['a', 'b', 'c'], 'b', 'previous')).toBe('a');
  });

  it('is bounded at the first and last rows', () => {
    expect(moveSelection(['a', 'b'], 'a', 'previous')).toBe('a');
    expect(moveSelection(['a', 'b'], 'b', 'next')).toBe('b');
  });
});

describe('isSelectionAtEnd', () => {
  it('is true only for the last row', () => {
    expect(isSelectionAtEnd(['a', 'b'], 'b')).toBe(true);
    expect(isSelectionAtEnd(['a', 'b'], 'a')).toBe(false);
    expect(isSelectionAtEnd([], 'a')).toBe(false);
  });
});
