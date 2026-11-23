import { describe, expect, it } from 'vitest';
import { createConfigurationRecordRequestSchema, createSessionInputSchema, sessionUsageSchema } from './index.js';

const model = { provider: 'openai', model: 'served' };
const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const session = {
  runId: 'run', phase: null, step: 'issue.classify', role: 'none', round: 0, model, inferenceSettings: {},
  startedAt: '2026-11-23T10:00:00Z', endedAt: null, durationMs: null, tokens, usageAvailable: false,
  assistantTurnCount: 0, toolCallCount: 0, outcome: 'failed'
};
const band = { minRequestInputTokens: 0, rates: { freshInput: 1000, output: 2000, cacheRead: 100, cacheWrite: 'not_applicable' } };
const settings = { ...model, effectiveAt: '2026-11-23T10:00:00.000Z', action: 'set', bands: [band] };
const request = (overrides: object = {}) => ({ tenant: 'tenant', kind: 'model_rate_table', settings: { ...settings, ...overrides } });

describe('session evidence and pricing API contracts', () => {
  it('does not accept any computed cost field or a payload amount, even zero', () => {
    expect(createSessionInputSchema.safeParse({ ...session, cost: { model, tokens } }).success).toBe(true);
    expect(createSessionInputSchema.safeParse({ ...session, cost: { model, tokens, usd: null } }).success).toBe(true);
    for (const fields of [{ usd: 0 }, { usd: 1 }, { gaps: [] }, { basis: 'api_list_price' }, { complete: false }, { rateVersionIds: [] }]) {
      expect(createSessionInputSchema.safeParse({ ...session, cost: { model, tokens, ...fields } }).success).toBe(false);
    }
  });

  it('rejects invalid totals, counts, bounds and overlapping subsets without throwing', () => {
    const all = { freshInput: 40, cacheRead: 60, cacheWrite: 2, output: 10 };
    const group = { model, requestInputTokens: 102, tokens: all };
    const usage = { coverage: 'complete', groups: [group], totals: all };
    expect(sessionUsageSchema.safeParse(usage).success).toBe(true);
    expect(sessionUsageSchema.safeParse({ ...usage, totals: { ...all, freshInput: 0 } }).success).toBe(false);
    for (const fields of [
      { tokens: { ...all, freshInput: 1.5 } },
      { tokens: { ...all, reasoningOutput: 11 } },
      { tokens: { ...all, cacheWriteByRetention: { '5m': 3 } } },
      { inputTotalCeilingTokens: 103 }, { requestInputTokens: 103 }
    ]) {
      expect(sessionUsageSchema.safeParse({ ...usage, groups: [{ ...group, ...fields }] }).success).toBe(false);
    }
  });

  it('rejects a claimed group ceiling below a measured input subtotal', () => {
    const totals = { freshInput: null, cacheRead: 60, cacheWrite: 'not_applicable', output: 10 };
    const group = { model, requestInputTokens: null, tokens: totals };
    expect(sessionUsageSchema.safeParse({
      coverage: 'complete', totals, groups: [{ ...group, inputTotalCeilingTokens: 100 }]
    }).success).toBe(true);
    expect(sessionUsageSchema.safeParse({
      coverage: 'complete', totals, groups: [{ ...group, inputTotalCeilingTokens: 59 }]
    }).success).toBe(false);
  });

  it('requires strict, safe schedules and canonical effective instants', () => {
    expect(createConfigurationRecordRequestSchema.safeParse(request()).success).toBe(true);
    for (const overrides of [
      { provider: ' openai' }, { model: 'bad\x00model' }, { revision: 1 }, { basis: null }, { contextLimitTokens: 0 },
      { effectiveAt: '2026-11-23T10:00:00Z' }, { effectiveAt: '2026-02-30T10:00:00.000Z' },
      { bands: [] }, { bands: [band, band] }, { bands: [{ ...band, minRequestInputTokens: 1 }] },
      { bands: [{ ...band, rates: { ...band.rates, output: Number.MAX_SAFE_INTEGER + 1 } }] },
      { bands: [{ ...band, rates: { ...band.rates, cacheWrite: { '5m': 100 } } }] },
      { action: 'retract', correctsId: 'cfg' }
    ]) expect(createConfigurationRecordRequestSchema.safeParse(request(overrides)).success).toBe(false);
    expect(createConfigurationRecordRequestSchema.safeParse({
      ...request(), settings: { ...model, effectiveAt: settings.effectiveAt, action: 'retract', correctsId: 'cfg' }
    }).success).toBe(true);
  });
});
