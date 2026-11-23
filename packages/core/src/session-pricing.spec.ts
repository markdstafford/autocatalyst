import { describe, expect, it } from 'vitest';
import {
  deriveUsageTotals, type BillingKey, type ModelRateRecord, type StoredSession, type UsageGroup, type UsageTokens
} from '@autocatalyst/api-contract';
import { priceRunSessions } from './session-pricing.js';

const openai: BillingKey = { provider: 'openai', model: 'exact-served-model' };
const claude: BillingKey = { provider: 'anthropic', model: 'claude-served' };
const instant = '2026-11-23T10:00:00.000Z';
const projections = { input: 100, output: 10, cacheRead: 60, cacheWrite: 0 };
const group = (input: Partial<UsageGroup> = {}): UsageGroup => ({
  model: openai, requestInputTokens: 100,
  tokens: { freshInput: 40, cacheRead: 60, cacheWrite: 'not_applicable', output: 10, reasoningOutput: 4 },
  ...input
});
function session(groups?: UsageGroup[], fields: Partial<StoredSession> = {}, coverage: 'complete' | 'partial' | 'unavailable' = 'complete'): StoredSession {
  return {
    id: 'session', runId: 'run', sequence: 1, phase: 'implementation', step: 'implementation.build', role: 'implementer',
    round: 1, model: openai, inferenceSettings: {}, startedAt: '2026-11-23T10:00:00Z', endedAt: instant, durationMs: 0,
    tokens: projections, usageAvailable: true, assistantTurnCount: 1, toolCallCount: 0, outcome: 'succeeded',
    cost: { model: openai, tokens: projections, usd: 987 },
    ...(groups === undefined ? {} : { usage: { groups, coverage, totals: deriveUsageTotals(groups, coverage) } }), ...fields
  };
}
const rate = (id: string, settings: Partial<Extract<ModelRateRecord['settings'], { action: 'set' }>> = {}): ModelRateRecord => ({
  id, tenant: 'tenant', kind: 'model_rate_table', createdAt: instant, updatedAt: instant,
  settings: {
    ...openai, action: 'set', basis: 'api_list_price', revision: 1, effectiveAt: instant,
    bands: [
      { minRequestInputTokens: 0, rates: { freshInput: 3000, cacheRead: 300, cacheWrite: 'not_applicable', output: 15000 } },
      { minRequestInputTokens: 101, rates: { freshInput: 6000, cacheRead: 300, cacheWrite: 'not_applicable', output: 15000 } }
    ], ...settings
  }
});
const getCost = (groups: UsageGroup[], history = [rate('first')]) => priceRunSessions([session(groups)], history).sessions[0]!.cost;

describe('read-time session pricing', () => {
  it('selects inclusive parsed instants, not the original strings; ignores future and retracted slots', () => {
    const old = rate('old', { effectiveAt: '2026-11-23T09:00:00.000Z' });
    const current = rate('current');
    const future = rate('future', { effectiveAt: '2026-11-23T10:00:00.001Z' });
    const before = session([group()], { startedAt: '2026-11-23T09:59:59.999999Z', id: 'before' });
    const sessions = [before, session([group()])];
    expect(priceRunSessions(sessions, [future, current, old]).sessions.map(({ cost }) => cost.rateVersionIds)).toEqual([['old'], ['current']]);
    const retract: ModelRateRecord = { ...current, id: 'retract', settings: {
      ...openai, effectiveAt: instant, action: 'retract', revision: 2, correctsId: current.id
    } };
    expect(priceRunSessions(sessions, [future, retract, current, old]).sessions.map(({ cost }) => cost.rateVersionIds)).toEqual([['old'], ['old']]);
  });

  it('charges disjoint counts including reasoning only once, and respects group ceilings', () => {
    expect(getCost([group()])).toMatchObject({ usd: 288000, complete: true, rateVersionIds: ['first'], gaps: [] });
    for (const contextLimitTokens of [100, 101]) {
      expect(getCost([group({ requestInputTokens: null, inputTotalCeilingTokens: 100 })], [rate('r', { contextLimitTokens })]))
        .toMatchObject({ usd: 288000, complete: true });
    }
  });

  it.each(['nearest_sample', 'largest_sample', 'lowest_feasible'] as const)('returns a priced but incomplete %s estimate', (method) => {
    const unsized = group({ requestInputTokens: null, inputTotalCeilingTokens: 160, tokens: {
      freshInput: 100, cacheRead: 60, cacheWrite: 'not_applicable', output: 10
    }, ...(method === 'lowest_feasible' ? {} : { requestSizeHint: { method, inputTokens: 230 } }) });
    expect(getCost([unsized])).toMatchObject({
      usd: method === 'lowest_feasible' ? 468000 : 768000, complete: false, gaps: [{
        code: 'estimated_request_size', tokenCount: '100', tokenClass: 'freshInput', method,
        bandMinRequestInputTokens: method === 'lowest_feasible' ? 0 : 101
      }]
    });
  });

  it('handles intersecting limits and ignores a configured ceiling contradicted elsewhere for that key', () => {
    const unbounded = group({ requestInputTokens: null, tokens: { freshInput: 10, cacheRead: null, cacheWrite: 'not_applicable', output: null } });
    const upper = rate('r', { contextLimitTokens: 100 });
    expect(getCost([unbounded], [upper]).gaps).not.toContainEqual(expect.objectContaining({ code: 'estimated_request_size' }));
    const large = group({ requestInputTokens: 101, tokens: { ...group().tokens, freshInput: 41 } });
    expect(getCost([unbounded, large], [upper]).gaps).toContainEqual(expect.objectContaining({ code: 'estimated_request_size', tokenCount: '10' }));
    expect(getCost([{ ...unbounded, contextWindowTokens: 90 }, large], [upper]).gaps)
      .not.toContainEqual(expect.objectContaining({ code: 'estimated_request_size' }));
    expect(getCost([{ ...large, requestInputTokens: null, requestInputRange: { min: 101, max: 101 } }], [upper]).complete).toBe(true);
  });

  it('prices common retention treatments once and estimates only the residual write portion', () => {
    const tokens: UsageTokens = { freshInput: 40, cacheRead: 100, cacheWrite: 25, cacheWriteByRetention: { '5m': 20 }, output: 10 };
    const rates = { freshInput: 3000, cacheRead: 300, output: 15000 };
    const history = [rate('claude', { ...claude, bands: [
      { minRequestInputTokens: 0, rates: { ...rates, cacheWrite: 4000 } },
      { minRequestInputTokens: 101, rates: { ...rates, cacheWrite: { '5m': 4000, '1h': 6000 } } }
    ] })];
    expect(getCost([group({ model: claude, requestInputTokens: null, tokens })], history)).toMatchObject({
      usd: 400000, complete: false, gaps: [{ code: 'estimated_request_size', tokenCount: '5' }]
    });
    expect(getCost([group({ model: claude, requestInputTokens: 165, tokens })], history)).toMatchObject({
      usd: 380000, complete: false, gaps: [{ code: 'missing_cache_retention', tokenCount: '5' }]
    });
    const malformed = group({ model: claude, requestInputTokens: 165, tokens: { ...tokens, cacheWriteByRetention: { '5m': 30 } } });
    expect(getCost([malformed], history)).toMatchObject({ usd: 300000, gaps: [{ code: 'missing_cache_retention', tokenCount: '25' }] });
  });

  it('can return an estimate when the only measured positive term is band dependent', () => {
    const onlyFresh = group({ requestInputTokens: null, tokens: { freshInput: 10, cacheRead: null, cacheWrite: 'not_applicable', output: null } });
    expect(getCost([onlyFresh])).toMatchObject({
      usd: 30000, complete: false, gaps: expect.arrayContaining([
        expect.objectContaining({ code: 'estimated_request_size', tokenCount: '10', method: 'lowest_feasible' }),
        expect.objectContaining({ code: 'missing_usage', tokenCount: null, tokenClass: 'output' })
      ])
    });
  });

  it('prices known write buckets with an unknown total and counts unsupported retention once', () => {
    const tokens: UsageTokens = { freshInput: null, cacheRead: null, cacheWrite: null,
      cacheWriteByRetention: { '5m': 20, '2h': 5 }, output: null };
    const schedule = rate('claude', { ...claude, bands: [{ minRequestInputTokens: 0, rates: {
      freshInput: 3000, cacheRead: 300, output: 15000, cacheWrite: { '5m': 4000, '1h': 6000 }
    } }] });
    expect(getCost([group({ model: claude, requestInputTokens: null, tokens })], [schedule])).toMatchObject({
      usd: 80000, complete: false, gaps: expect.arrayContaining([
        expect.objectContaining({ code: 'incompatible_rate', tokenCount: '5', tokenClass: 'cacheWrite' }),
        expect.objectContaining({ code: 'missing_usage', tokenCount: null, tokenClass: 'cacheWrite' })
      ])
    });
  });

  it('distinguishes overflow, unpriced coverage, priced zero and empty reads', () => {
    const zero = group({ requestInputTokens: 0, tokens: { freshInput: 0, cacheRead: 0, cacheWrite: 'not_applicable', output: 0 } });
    expect(getCost([zero])).toMatchObject({ usd: 0, complete: true, gaps: [] });
    expect(getCost([group({ model: null })])).toMatchObject({ usd: null, complete: false });
    expect(priceRunSessions([], []).costTotals).toEqual({ steps: [], run: {
      basis: 'api_list_price', knownSubtotalUsd: null, complete: false, sessionCount: 0, pricedSessionCount: 0, unpricedSessionCount: 0, gaps: []
    } });
    const overflow = group({ requestInputTokens: null, tokens: { ...group().tokens, freshInput: Number.MAX_SAFE_INTEGER } });
    expect(getCost([overflow])).toMatchObject({ usd: null, gaps: expect.arrayContaining([{ code: 'amount_overflow', tokenCount: null }]) });
    const big = group({ requestInputTokens: 40, tokens: { freshInput: 40, cacheRead: 0, cacheWrite: 'not_applicable', output: 0 } });
    const expensive = rate('big', { bands: [{ minRequestInputTokens: 0, rates: {
      freshInput: 200_000_000_000_000, cacheRead: 0, output: 0, cacheWrite: 'not_applicable'
    } }] });
    expect(priceRunSessions([session([big]), session([big], { id: 'second' })], [expensive]).costTotals.run)
      .toMatchObject({ knownSubtotalUsd: null, pricedSessionCount: 2, gaps: [{ code: 'amount_overflow', sessionCount: 0, hasUnknownTokenCount: false }] });
  });

  it('groups logical steps across roles/rounds and aggregates sized/unsized gaps by distinct session', () => {
    const unknown = group({ model: null, requestInputTokens: null, tokens: { freshInput: null, cacheRead: 1, output: 2, cacheWrite: 'not_applicable' } });
    const counted = group({ model: null });
    const { costTotals } = priceRunSessions([
      session([unknown, counted, counted]),
      session([counted], { id: 'second', role: 'reviewer', round: 2 }, 'partial'),
      session(undefined, { id: 'legacy', phase: null, step: 'issue.classify' })
    ], []);
    expect(costTotals.steps.map(({ phase, step, sessionCount }) => [phase, step, sessionCount]))
      .toEqual([[null, 'issue.classify', 1], ['implementation', 'implementation.build', 2]]);
    expect(costTotals.run.gaps).toContainEqual({
      code: 'missing_model', tokenClass: 'freshInput', tokenCount: '120', hasUnknownTokenCount: true, sessionCount: 2
    });
    expect(costTotals.run.gaps).toContainEqual({
      code: 'partial_usage', tokenCount: null, hasUnknownTokenCount: true, sessionCount: 1
    });
  });
});
