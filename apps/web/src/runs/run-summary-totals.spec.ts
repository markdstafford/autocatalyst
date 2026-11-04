/**
 * Summary totals tests: completed-session time, token breakdown, the three cost cases
 * (all priced, one unpriced, no sessions), and an integer-exact cost sum with a value
 * that would drift under floating-point addition.
 */
import { describe, expect, it } from 'vitest';

import { makeSession } from './run-fixtures.js';
import {
  computeSummaryTotals,
  formatCompactTokens,
  formatDurationMs,
  formatNanoUsd,
  formatTokenBreakdown,
  NANO_DOLLARS_PER_USD
} from './run-summary-totals.js';

describe('computeSummaryTotals', () => {
  it('dashes every total when there are no sessions', () => {
    const totals = computeSummaryTotals([]);
    expect(totals.time).toEqual({ kind: 'dash' });
    expect(totals.tokens).toEqual({ kind: 'dash' });
    expect(totals.cost).toEqual({ kind: 'dash' });
  });

  it('sums only completed-session durations and excludes running sessions', () => {
    const totals = computeSummaryTotals([
      makeSession({ id: 's1', durationMs: 1500 }),
      makeSession({ id: 's2', durationMs: 2500 }),
      makeSession({ id: 's3', durationMs: null }) // running: excluded
    ]);
    expect(totals.time).toEqual({ kind: 'value', ms: 4000 });
  });

  it('sums all four token classes and reports the breakdown', () => {
    const totals = computeSummaryTotals([
      makeSession({ id: 's1', tokens: { input: 100, output: 20, cacheRead: 5, cacheWrite: 1 } }),
      makeSession({ id: 's2', tokens: { input: 200, output: 30, cacheRead: 7, cacheWrite: 2 } })
    ]);
    expect(totals.tokens).toEqual({
      kind: 'value',
      total: 100 + 20 + 5 + 1 + 200 + 30 + 7 + 2,
      breakdown: { input: 300, output: 50, cacheRead: 12, cacheWrite: 3 }
    });
  });

  it('sums cost as integer nano-dollars when every session is priced', () => {
    const totals = computeSummaryTotals([
      makeSession({ id: 's1', usd: 300_000_000 }),
      makeSession({ id: 's2', usd: 200_000_000 })
    ]);
    expect(totals.cost).toEqual({ kind: 'value', nanoUsd: 500_000_000 });
  });

  it('reports unknown cost when any session is unpriced and shows no partial sum', () => {
    const totals = computeSummaryTotals([
      makeSession({ id: 's1', usd: 300_000_000 }),
      makeSession({ id: 's2', usd: null })
    ]);
    expect(totals.cost).toEqual({ kind: 'unknown' });
  });

  it('keeps the cost sum integer-exact for amounts that drift under float addition', () => {
    // $0.10 and $0.20 as nano-dollars. A float sum of 0.1 + 0.2 is 0.30000000000000004;
    // summing the integer nano-dollars first and formatting is exactly $0.30.
    const tenCents = NANO_DOLLARS_PER_USD / 10; // 100_000_000
    const twentyCents = (NANO_DOLLARS_PER_USD / 10) * 2; // 200_000_000
    const totals = computeSummaryTotals([
      makeSession({ id: 's1', usd: tenCents }),
      makeSession({ id: 's2', usd: twentyCents })
    ]);
    expect(totals.cost).toEqual({ kind: 'value', nanoUsd: 300_000_000 });
    if (totals.cost.kind === 'value') {
      expect(formatNanoUsd(totals.cost.nanoUsd)).toBe('$0.30');
    }
  });
});

describe('formatting helpers', () => {
  it('formats durations with the two largest units', () => {
    expect(formatDurationMs(0)).toBe('0s');
    expect(formatDurationMs(4000)).toBe('4s');
    expect(formatDurationMs(90_000)).toBe('1m 30s');
    expect(formatDurationMs(3_600_000)).toBe('1h');
    expect(formatDurationMs(3_900_000)).toBe('1h 5m');
  });

  it('compacts token counts', () => {
    expect(formatCompactTokens(950)).toBe('950');
    expect(formatCompactTokens(1_200)).toBe('1.2K');
    expect(formatCompactTokens(1_000)).toBe('1K');
    expect(formatCompactTokens(3_400_000)).toBe('3.4M');
  });

  it('formats a token breakdown with each class labeled', () => {
    expect(formatTokenBreakdown({ input: 1000, output: 50, cacheRead: 10, cacheWrite: 5 })).toBe(
      'Input 1,000 · Output 50 · Cache read 10 · Cache write 5'
    );
  });

  it('formats nano-dollars without floating point division', () => {
    expect(formatNanoUsd(0)).toBe('$0.00');
    expect(formatNanoUsd(300_000_000)).toBe('$0.30');
    expect(formatNanoUsd(1_234_500_000)).toBe('$1.2345');
    expect(formatNanoUsd(2_000_000_000)).toBe('$2.00');
  });
});
