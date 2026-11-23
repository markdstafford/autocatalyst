import {
  type BillingKey, type ModelRateBand, type ModelRateRecord, type ModelRateSettings,
  type PricedSessionCost, type SessionCostGap, type SessionCostTotal, type SessionCostTotals,
  type StoredSession, type TokenCount, type UsageGroup, type UsageTokens, closedInputSize, usageTokenClasses
} from '@autocatalyst/api-contract';

type RateSet = Extract<ModelRateSettings, { action: 'set' }>;
interface EffectiveRate { id: string; instant: number; settings: RateSet }
type RateIndex = ReadonlyMap<string, readonly EffectiveRate[]>;
const basis = 'api_list_price' as const;
const maxAmount = BigInt(Number.MAX_SAFE_INTEGER);
const keyOf = ({ provider, model }: BillingKey) => JSON.stringify([provider, model]);

function indexRates(records: readonly ModelRateRecord[]): RateIndex {
  const heads = new Map<string, ModelRateRecord>();
  for (const record of records) {
    const settings = record.settings;
    const slot = JSON.stringify([settings.provider, settings.model, Date.parse(settings.effectiveAt)]);
    if ((heads.get(slot)?.settings.revision ?? 0) < settings.revision) heads.set(slot, record);
  }
  const index = new Map<string, EffectiveRate[]>();
  for (const { id, settings } of heads.values()) {
    if (settings.action !== 'set') continue;
    const key = keyOf(settings);
    const rates = index.get(key) ?? [];
    rates.push({ id, instant: Date.parse(settings.effectiveAt), settings });
    index.set(key, rates);
  }
  for (const rates of index.values()) rates.sort((a, b) => b.instant - a.instant);
  return index;
}

type TokenClass = (typeof usageTokenClasses)[number];
type Portion = { tokenClass: TokenClass; count: TokenCount; retention?: string };
type Treatment = number | 'not_applicable' | 'missing_cache_retention' | 'incompatible_rate';

function portions(tokens: UsageTokens): Portion[] {
  const buckets = Object.entries(tokens.cacheWriteByRetention ?? {}).sort(([a], [b]) => compare(a, b));
  const allocated = buckets.reduce((sum, [, count]) => sum + BigInt(count), 0n);
  const writes = tokens.cacheWrite;
  const split = writes !== 'not_applicable' && (writes === null || allocated <= BigInt(writes));
  return [
    { tokenClass: 'freshInput', count: tokens.freshInput },
    { tokenClass: 'cacheRead', count: tokens.cacheRead },
    ...(split ? buckets.map(([retention, count]) => ({ tokenClass: 'cacheWrite' as const, count, retention })) : []),
    { tokenClass: 'cacheWrite', count: split && typeof writes === 'number' ? writes - Number(allocated) : writes },
    { tokenClass: 'output', count: tokens.output }
  ];
}

function treatment(band: ModelRateBand, portion: Portion): Treatment {
  if (portion.tokenClass !== 'cacheWrite') return band.rates[portion.tokenClass];
  const rate = band.rates.cacheWrite;
  if (typeof rate !== 'object') return rate;
  if (portion.retention === undefined) return 'missing_cache_retention';
  return portion.retention === '5m' || portion.retention === '1h' ? rate[portion.retention] : 'incompatible_rate';
}

function feasibleBands(group: UsageGroup, settings: RateSet, provenKeySize: number): ModelRateBand[] {
  const { requestInputTokens: exact, requestInputRange: range, contextWindowTokens: native } = group;
  const floor = exact ?? range?.min ?? 0;
  const ownSize = exact ?? range?.max ?? 0;
  const configured = settings.contextLimitTokens ?? Infinity;
  const ceiling = exact ?? Math.min(
    configured >= provenKeySize ? configured : Infinity,
    native !== undefined && native >= ownSize ? native : Infinity,
    group.inputTotalCeilingTokens ?? closedInputSize(group.tokens) ?? Infinity,
    range?.max ?? Infinity
  );
  return settings.bands.filter((band, i) =>
    band.minRequestInputTokens <= ceiling && (settings.bands[i + 1]?.minRequestInputTokens ?? Infinity) > floor);
}

function priceSession(session: StoredSession, rates: RateIndex): StoredSession & { cost: PricedSessionCost } {
  const gaps: SessionCostGap[] = [];
  const rateIds = new Set<string>();
  let amount = 0n;
  let measured = false;
  const charge = (count: number, rate: number) => {
    amount += BigInt(count) * BigInt(rate);
    measured = true;
  };
  const usage = session.usage;
  if (usage === undefined) {
    gaps.push({ code: 'legacy_cache_detail', tokenCount: null });
    if (!session.usageAvailable) gaps.push({ code: 'missing_usage', tokenCount: null });
  } else if (usage.coverage === 'unavailable') {
    gaps.push({ code: 'missing_usage', tokenCount: null });
  } else {
    if (usage.coverage === 'partial') gaps.push({ code: 'partial_usage', tokenCount: null });
    // Effective instants have millisecond precision. Date.parse truncating any finer
    // session fraction cannot cross a rate boundary.
    const instant = Date.parse(session.startedAt);
    const provenSizes = new Map<string, number>();
    for (const group of usage.groups) {
      if (group.model === null) continue;
      const key = keyOf(group.model);
      provenSizes.set(key, Math.max(provenSizes.get(key) ?? 0, group.requestInputTokens ?? group.requestInputRange?.max ?? 0));
    }
    usage.groups.forEach((group, groupIndex) => {
      const key = group.model === null ? null : keyOf(group.model);
      const rate = key === null ? undefined : rates.get(key)?.find((candidate) => candidate.instant <= instant);
      if (rate !== undefined) rateIds.add(rate.id);
      const bands = rate === undefined ? [] : feasibleBands(group, rate.settings, provenSizes.get(key!) ?? 0);
      const hint = group.requestSizeHint;
      // Selecting the last feasible minimum below the hint clamps it at both ends.
      const estimatedBand = (hint === undefined ? bands[0] :
        [...bands].reverse().find((band) => band.minRequestInputTokens <= hint.inputTokens) ?? bands[0]);
      for (const portion of portions(group.tokens)) {
        const { count, tokenClass } = portion;
        if (count === 'not_applicable') continue;
        const identity = { ...group.model, groupIndex, tokenClass, tokenCount: count === null ? null : String(count) };
        if (rate === undefined) {
          if (count !== 0) gaps.push({ ...identity, code: key === null ? 'missing_model' : 'missing_rate' });
          continue;
        }
        const treatments = bands.map((band) => treatment(band, portion));
        if (count === null) {
          if (!treatments.every((value) => value === 'not_applicable' && portion.retention === undefined)) {
            gaps.push({ ...identity, code: 'missing_usage' });
          }
          continue;
        }
        if (count === 0) {
          if (treatments.length > 0 && treatments.every((value) => typeof value === 'number')) charge(0, 0);
          continue;
        }
        const same = treatments.length > 0 && treatments.every((value) => value === treatments[0]);
        if (!same && !treatments.some((value) => typeof value === 'number')) {
          gaps.push({ ...identity, code: 'missing_request_size' });
          continue;
        }
        const value = same ? treatments[0]! : treatment(estimatedBand!, portion);
        if (typeof value === 'number') {
          charge(count, value);
          if (!same) gaps.push({
            ...identity, code: 'estimated_request_size', method: hint?.method ?? 'lowest_feasible',
            bandMinRequestInputTokens: estimatedBand!.minRequestInputTokens
          });
        } else {
          gaps.push({ ...identity, code: value === 'not_applicable' ? 'incompatible_rate' : value });
        }
      }
    });
  }
  if (amount > maxAmount) gaps.push({ code: 'amount_overflow', tokenCount: null });
  if (!measured && gaps.length === 0) gaps.push({ code: 'missing_usage', tokenCount: null });
  const usd = measured && amount <= maxAmount ? Number(amount) : null;
  return { ...session, cost: {
    model: session.cost.model, tokens: session.cost.tokens, usd, basis,
    complete: usage?.coverage === 'complete' && gaps.length === 0 && usd !== null,
    rateVersionIds: [...rateIds].sort(), gaps
  } };
}

function compare(a: string | null | undefined, b: string | null | undefined): number {
  if (a == null) return b == null ? 0 : -1;
  if (b == null) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

type PricedSession = ReturnType<typeof priceSession>;
type RollupGap = SessionCostTotal['gaps'][number];
function rollup(sessions: readonly PricedSession[]): SessionCostTotal {
  const grouped = new Map<string, { gap: RollupGap; affected: Set<string>; tokens: bigint | null }>();
  let amount = 0n;
  let pricedSessionCount = 0;
  for (const { id, cost } of sessions) {
    if (cost.usd !== null) {
      amount += BigInt(cost.usd);
      pricedSessionCount++;
    }
    for (const { groupIndex: _groupIndex, ...gap } of cost.gaps) {
      const method = gap.code === 'estimated_request_size' ? gap.method : undefined;
      const key = JSON.stringify([gap.code, gap.provider, gap.model, gap.tokenClass, method]);
      let entry = grouped.get(key);
      if (entry === undefined) {
        const identity = gap.code === 'estimated_request_size'
          ? { code: gap.code, method: gap.method, tokenClass: gap.tokenClass } as const
          : gap.code === 'missing_request_size'
            ? { code: gap.code, tokenClass: gap.tokenClass } as const
            : { code: gap.code, ...(gap.tokenClass !== undefined ? { tokenClass: gap.tokenClass } : {}) };
        entry = { gap: {
          ...identity, ...(gap.provider === undefined ? {} : { provider: gap.provider }),
          ...(gap.model === undefined ? {} : { model: gap.model }),
          tokenCount: null, hasUnknownTokenCount: false, sessionCount: 0
        }, affected: new Set(), tokens: null };
        grouped.set(key, entry);
      }
      entry.affected.add(id);
      if (gap.tokenCount !== null) entry.tokens = (entry.tokens ?? 0n) + BigInt(gap.tokenCount);
      else if (gap.code !== 'amount_overflow') entry.gap.hasUnknownTokenCount = true;
    }
  }
  const gaps: RollupGap[] = [...grouped.values()].map(({ gap, affected, tokens }) => ({
    ...gap, sessionCount: affected.size, tokenCount: tokens?.toString() ?? null
  }));
  if (amount > maxAmount) gaps.push({ code: 'amount_overflow', sessionCount: 0, tokenCount: null, hasUnknownTokenCount: false });
  gaps.sort((a, b) => compare(a.code, b.code) || compare(a.provider, b.provider) || compare(a.model, b.model) ||
    compare(a.tokenClass, b.tokenClass) ||
    compare('method' in a ? a.method : undefined, 'method' in b ? b.method : undefined));
  const knownSubtotalUsd = pricedSessionCount > 0 && amount <= maxAmount ? Number(amount) : null;
  return {
    basis, knownSubtotalUsd, complete: knownSubtotalUsd !== null && sessions.every(({ cost }) => cost.complete),
    sessionCount: sessions.length, pricedSessionCount, unpricedSessionCount: sessions.length - pricedSessionCount, gaps
  };
}

export function priceRunSessions(sessions: readonly StoredSession[], history: readonly ModelRateRecord[]): {
  sessions: PricedSession[]; costTotals: SessionCostTotals;
} {
  const rates = indexRates(history);
  const priced = sessions.map((session) => priceSession(session, rates));
  const logicalSteps = new Map<string, { phase: string | null; step: string; sessions: PricedSession[] }>();
  for (const session of priced) {
    const { phase, step } = session;
    const key = JSON.stringify([phase, step]);
    const entry = logicalSteps.get(key) ?? { phase, step, sessions: [] };
    entry.sessions.push(session);
    logicalSteps.set(key, entry);
  }
  const steps = [...logicalSteps.values()].sort((a, b) => compare(a.phase, b.phase) || compare(a.step, b.step));
  return { sessions: priced, costTotals: {
    run: rollup(priced), steps: steps.map(({ phase, step, sessions: members }) => ({ phase, step, ...rollup(members) }))
  } };
}
