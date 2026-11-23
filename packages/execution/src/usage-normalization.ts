import {
  billingKeySchema, closedInputSize, deriveUsageTotals, hasMeasuredUsage, sumSafeCounts, usageTokenClasses,
  type BillingKey, type SessionUsage, type UsageGroup, type UsageTokens
} from '@autocatalyst/api-contract';
import type { AgentTokenUsage } from './agent-provider-adapter.js';

export function usageRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function usageCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export type NativeUsageAnomaly = 'invalid_counter' | 'invalid_cache_split' | 'invalid_retention_split' | 'invalid_reasoning_subset';
type ReportAnomaly = (code: NativeUsageAnomaly) => void;

function nativeCount(value: unknown, report?: ReportAnomaly): number | null {
  const count = usageCount(value);
  if (value != null && count === null) report?.('invalid_counter');
  return count;
}

export function usageBillingKey(provider: string, model: unknown): BillingKey | null {
  const parsed = billingKeySchema.safeParse({ provider, model });
  return parsed.success ? parsed.data : null;
}

export function openAIUsageTokens(
  inclusive: number | null, cached: number | null, output: number | null, reasoning: number | null,
  unexpectedWrites = false
): UsageTokens {
  const read = inclusive !== null && cached !== null && cached > inclusive ? null : cached;
  return {
    freshInput: !unexpectedWrites && inclusive !== null && read !== null ? inclusive - read : null,
    cacheRead: read, cacheWrite: unexpectedWrites ? null : 'not_applicable', output,
    ...(reasoning !== null && (output === null || reasoning <= output) ? { reasoningOutput: reasoning } : {})
  };
}

export function anthropicUsageTokens(raw: unknown, keyed = false, report?: ReportAnomaly): UsageTokens {
  const usage = usageRecord(raw);
  const cacheWrite = nativeCount(usage[keyed ? 'cacheCreationInputTokens' : 'cache_creation_input_tokens'], report);
  const creation = usageRecord(usage['cache_creation']);
  const byRetention = Object.fromEntries(Object.entries(creation).flatMap(([key, value]) => {
    const label = /^ephemeral_([a-zA-Z0-9-]+)_input_tokens$/u.exec(key)?.[1];
    const count = label === undefined ? null : nativeCount(value, report);
    return label === undefined || count === null ? [] : [[label, count] as const];
  }));
  const counts = Object.values(byRetention);
  const sum = sumSafeCounts(counts);
  const validSplit = cacheWrite === null || (sum !== null && sum <= cacheWrite);
  if (!validSplit) report?.('invalid_retention_split');
  return {
    freshInput: nativeCount(usage[keyed ? 'inputTokens' : 'input_tokens'], report),
    cacheRead: nativeCount(usage[keyed ? 'cacheReadInputTokens' : 'cache_read_input_tokens'], report),
    cacheWrite,
    output: nativeCount(usage[keyed ? 'outputTokens' : 'output_tokens'], report),
    ...(counts.length > 0 && validSplit ? { cacheWriteByRetention: byRetention } : {})
  };
}

export function usageGroup(model: BillingKey | null, tokens: UsageTokens, singleRequest: boolean, inclusive?: number | null): UsageGroup {
  const ceiling = closedInputSize(tokens) ?? inclusive ?? null;
  return {
    model, tokens, requestInputTokens: singleRequest ? ceiling : null,
    ...(ceiling === null ? {} : { inputTotalCeilingTokens: ceiling })
  };
}

export function normalizeSessionUsage(
  groups: readonly UsageGroup[], closed: boolean, nativeInclusiveInput?: number | null
): AgentTokenUsage {
  const capped = groups.length > 256;
  let evidence = [...groups];
  if (capped) {
    // If adjacent same-key merges cannot satisfy the cap (e.g. 257 different
    // served keys), retain remaining disjoint known counts once rather than
    // silently losing every count above the limit. Attribution and bounds are
    // unavailable for this combined remainder.
    const remainder = deriveUsageTotals(groups.slice(255), 'partial');
    const writeUnknown = groups.slice(255).some(({ tokens }) => tokens.cacheWrite === null);
    if (writeUnknown) remainder.cacheWrite = null;
    if (typeof remainder.output === 'number' && remainder.reasoningOutput !== undefined && remainder.reasoningOutput > remainder.output) {
      delete remainder.reasoningOutput;
    }
    evidence = [...groups.slice(0, 255), { model: null, requestInputTokens: null, tokens: remainder }];
  }
  const hasGroups = evidence.some(({ tokens, inputTotalCeilingTokens }) =>
    hasMeasuredUsage(tokens) || inputTotalCeilingTokens !== undefined);
  const finalCoverage = hasGroups ? closed && !capped ? 'complete' : 'partial' : 'unavailable';
  if (!hasGroups) evidence = [];
  const totals = deriveUsageTotals(evidence, finalCoverage);
  const numberOrZero = (value: unknown) => usageCount(value) ?? 0;
  const input = nativeInclusiveInput === undefined ? numberOrZero(totals.freshInput) : numberOrZero(nativeInclusiveInput);
  return {
    available: hasGroups,
    ...(hasGroups ? { tokens: {
      input, output: numberOrZero(totals.output), cacheRead: numberOrZero(totals.cacheRead), cacheWrite: numberOrZero(totals.cacheWrite)
    } } : {}),
    usage: { coverage: finalCoverage, totals, groups: evidence } satisfies SessionUsage
  };
}

export function normalizeOpenAIResponse(raw: unknown, model: unknown, report?: ReportAnomaly): AgentTokenUsage {
  const usage = usageRecord(raw);
  const inclusive = nativeCount(usage['input_tokens'], report);
  const cached = nativeCount(usageRecord(usage['input_tokens_details'])['cached_tokens'], report);
  const output = nativeCount(usage['output_tokens'], report);
  const reasoning = nativeCount(usageRecord(usage['output_tokens_details'])['reasoning_tokens'], report);
  if (inclusive !== null && cached !== null && cached > inclusive) report?.('invalid_cache_split');
  if (output !== null && reasoning !== null && reasoning > output) report?.('invalid_reasoning_subset');
  const tokens = openAIUsageTokens(inclusive, cached, output, reasoning);
  return normalizeSessionUsage([usageGroup(usageBillingKey('openai', model), tokens, true, inclusive)], true, inclusive);
}

/** Closed requests may share a group only when merging preserves all count states and size evidence. */
function mergeGroups(a: UsageGroup, b: UsageGroup, range: boolean): UsageGroup | null {
  if (JSON.stringify(a.model) !== JSON.stringify(b.model) ||
      a.contextWindowTokens !== b.contextWindowTokens || a.requestSizeHint || b.requestSizeHint) return null;
  const rangeA = a.requestInputRange ?? (a.requestInputTokens === null ? null : { min: a.requestInputTokens, max: a.requestInputTokens });
  const rangeB = b.requestInputRange ?? (b.requestInputTokens === null ? null : { min: b.requestInputTokens, max: b.requestInputTokens });
  if (rangeA === null || rangeB === null || (!range && a.requestInputTokens !== b.requestInputTokens)) return null;
  const tokens = { ...a.tokens };
  for (const key of usageTokenClasses) {
    const first = a.tokens[key], second = b.tokens[key];
    if (typeof first === 'number' && typeof second === 'number') {
      const total = sumSafeCounts([first, second]);
      if (total === null) return null;
      tokens[key] = total;
    } else if (first !== second) return null;
  }
  const retentionKeys = new Set([...Object.keys(a.tokens.cacheWriteByRetention ?? {}), ...Object.keys(b.tokens.cacheWriteByRetention ?? {})]);
  if (retentionKeys.size > 0) {
    const sums: [string, number][] = [];
    for (const key of retentionKeys) {
      const value = sumSafeCounts([a.tokens.cacheWriteByRetention?.[key] ?? 0, b.tokens.cacheWriteByRetention?.[key] ?? 0]);
      if (value === null) return null;
      sums.push([key, value]);
    }
    tokens.cacheWriteByRetention = Object.fromEntries(sums);
  }
  const reasoning = [a.tokens.reasoningOutput, b.tokens.reasoningOutput].filter((v): v is number => v !== undefined);
  if (reasoning.length > 0) {
    const total = sumSafeCounts(reasoning);
    if (total === null) delete tokens.reasoningOutput;
    else tokens.reasoningOutput = total;
  }
  const ceiling = closedInputSize(tokens);
  return {
    model: a.model, tokens, requestInputTokens: range ? null : a.requestInputTokens,
    ...(range ? { requestInputRange: { min: Math.min(rangeA.min, rangeB.min), max: Math.max(rangeA.max, rangeB.max) } } : {}),
    ...(ceiling !== null ? { inputTotalCeilingTokens: ceiling } : {}),
    ...(a.contextWindowTokens !== undefined ? { contextWindowTokens: a.contextWindowTokens } : {})
  };
}

export function compactUsageGroups(groups: readonly UsageGroup[]): UsageGroup[] {
  const result: UsageGroup[] = [];
  const exactGroups = new Map<string, number>();
  for (const group of groups) {
    const key = JSON.stringify([group.model, group.requestInputTokens, group.contextWindowTokens,
      ...usageTokenClasses.map((name) => typeof group.tokens[name] === 'number' ? 'known' : group.tokens[name])]);
    const i = group.requestInputTokens === null ? undefined : exactGroups.get(key);
    const merged = i === undefined ? null : mergeGroups(result[i]!, group, false);
    if (i !== undefined && merged !== null) result[i] = merged;
    else {
      if (group.requestInputTokens !== null) exactGroups.set(key, result.length);
      result.push(group);
    }
  }
  if (result.length <= 256) return result;
  const capped: UsageGroup[] = [];
  let remaining = result.length - 256;
  for (const group of result) {
    const prior = capped[capped.length - 1];
    const merged = prior !== undefined && remaining > 0 ? mergeGroups(prior, group, true) : null;
    if (merged === null) capped.push(group);
    else { capped[capped.length - 1] = merged; remaining--; }
  }
  return capped;
}
