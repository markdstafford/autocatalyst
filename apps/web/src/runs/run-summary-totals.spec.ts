import { describe, expect, it } from 'vitest';
import { deriveUsageTotals, type UsageGroup } from '@autocatalyst/api-contract';

import { makeSession } from './run-fixtures.js';
import { describeRunCost, formatCompactTokens, formatDurationMs, formatNanoUsd, summaryDuration, summaryTokens } from './run-summary-totals.js';

const group: UsageGroup = {
  model: { provider: 'openai', model: 'served' }, requestInputTokens: 100,
  tokens: { freshInput: 40, cacheRead: 60, cacheWrite: 'not_applicable', output: 10, reasoningOutput: 4 }
};
const session = makeSession({ usage: { groups: [group], coverage: 'complete', totals: deriveUsageTotals([group], 'complete') } });

describe('Summary totals', () => {
  it('sums only completed-session durations', () => {
    expect(summaryDuration([])).toBeNull();
    expect(summaryDuration([makeSession({ durationMs: 1500 }), makeSession({ durationMs: 2500 }), makeSession({ durationMs: null })])).toBe(4000);
    expect(formatDurationMs(90_000)).toBe('1m 30s');
  });

  it('displays disjoint counts, with legacy usage separate', () => {
    expect(summaryTokens([session])).toEqual({
      text: '110', detail: 'Fresh input: 40 · Cache reads: 60 · Cache writes: Not applicable · Output: 10.'
    });
    const legacy = makeSession({ tokens: { input: 100, output: 20, cacheRead: 5, cacheWrite: 1 } });
    expect(summaryTokens([legacy]).text).toBe('126 · Legacy');
    expect(summaryTokens([session, legacy])).toMatchObject({
      text: '110 · Incomplete', detail: expect.stringContaining('Legacy: 126 tokens in 1 session.')
    });
    const unavailable = makeSession({ usage: { groups: [], coverage: 'unavailable', totals: deriveUsageTotals([], 'unavailable') } });
    expect(summaryTokens([unavailable]).text).toBe('Unknown · Incomplete');
  });

  it('formats nano-dollars and compact counts without floating point', () => {
    expect(formatNanoUsd(0)).toBe('$0.00');
    expect(formatNanoUsd(300_000_001)).toBe('$0.300000001');
    expect(formatNanoUsd(Number.MAX_SAFE_INTEGER)).toBe('$9,007,199.254740991');
    expect(formatCompactTokens(1_200n)).toBe('1.2K');
  });

  it('explains estimate and overflow separately from missing counts', () => {
    const detail = describeRunCost({
      basis: 'api_list_price', knownSubtotalUsd: null, complete: false, sessionCount: 2, pricedSessionCount: 2, unpricedSessionCount: 0,
      gaps: [
        { code: 'estimated_request_size', method: 'lowest_feasible', tokenClass: 'freshInput', tokenCount: '1000000', hasUnknownTokenCount: false, sessionCount: 1 },
        { code: 'amount_overflow', tokenCount: null, hasUnknownTokenCount: false, sessionCount: 0 }
      ]
    });
    expect(detail).toContain('1,000,000 tokens');
    expect(detail).toContain('true amount may be higher');
    expect(detail).toContain('Amount exceeds the displayable range: run subtotal');
    expect(detail).not.toContain('cannot be counted');
  });
});
