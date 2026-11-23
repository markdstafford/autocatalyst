import { z } from 'zod';

export const safeCountSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const identityPart = z.string().min(1).refine(
  (value) => value === value.trim() && !/[\p{Cc}]/u.test(value),
  'Expected a billing identity without padding or control characters.'
);
export const billingKeySchema = z.object({ provider: identityPart, model: identityPart }).strict();
export const usageTokenClasses = ['freshInput', 'cacheRead', 'cacheWrite', 'output'] as const;
export const usageTokenClassSchema = z.enum(usageTokenClasses);
export const requestSizeHintMethodSchema = z.enum(['nearest_sample', 'largest_sample']);
const count = z.union([safeCountSchema, z.literal('not_applicable')]).nullable();
const usageTokensSchema = z.object({
  freshInput: count, cacheRead: count, cacheWrite: count, output: count,
  cacheWriteByRetention: z.record(z.string().min(1), safeCountSchema).optional(),
  reasoningOutput: safeCountSchema.optional()
}).strict();

export function sumSafeCounts(values: readonly number[]): number | null {
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) return null;
  const sum = values.reduce((total, value) => total + BigInt(value), 0n);
  return sum <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(sum) : null;
}

export function closedInputSize(tokens: UsageTokens): number | null {
  const counts = [tokens.freshInput, tokens.cacheRead, tokens.cacheWrite];
  return counts.includes(null) ? null : sumSafeCounts(counts.filter((n): n is number => typeof n === 'number'));
}

const usageGroupSchema = z.object({
  model: billingKeySchema.nullable(), tokens: usageTokensSchema,
  requestInputTokens: safeCountSchema.nullable(),
  contextWindowTokens: safeCountSchema.min(1).optional(),
  inputTotalCeilingTokens: safeCountSchema.optional(),
  requestInputRange: z.object({ min: safeCountSchema, max: safeCountSchema }).strict().optional(),
  requestSizeHint: z.object({ method: requestSizeHintMethodSchema, inputTokens: safeCountSchema }).strict().optional()
}).strict().superRefine((group, ctx) => {
  const { tokens, requestInputTokens: exact, requestInputRange: range, inputTotalCeilingTokens: ceiling } = group;
  const size = closedInputSize(tokens);
  const writes = Object.values(tokens.cacheWriteByRetention ?? {});
  const writeSum = sumSafeCounts(writes);
  const observedInput = [tokens.freshInput, tokens.cacheRead, tokens.cacheWrite, ...(tokens.cacheWrite === null ? writes : [])]
    .reduce<bigint>((total, value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
      ? total + BigInt(value) : total, 0n);
  if ((exact !== null && (group.requestSizeHint !== undefined || range !== undefined ||
        (size !== null && (exact === 0 ? size !== 0 : size < exact || size % exact !== 0)) || (ceiling !== undefined && ceiling < exact))) ||
      (range !== undefined && (range.min > range.max || (size !== null && range.max > size) ||
        (ceiling !== undefined && range.max > ceiling))) ||
      (ceiling !== undefined && size !== null && ceiling !== size) ||
      (ceiling !== undefined && Number.isSafeInteger(ceiling) && observedInput > BigInt(ceiling)) ||
      (tokens.reasoningOutput !== undefined && (tokens.output === 'not_applicable' ||
        (typeof tokens.output === 'number' && tokens.reasoningOutput > tokens.output))) ||
      (writes.length > 0 && (tokens.cacheWrite === 'not_applicable' ||
        (typeof tokens.cacheWrite === 'number' && (writeSum === null || writeSum > tokens.cacheWrite))))) {
    ctx.addIssue({ code: 'custom', message: 'Inconsistent usage group evidence.' });
  }
});

export function deriveUsageTotals(groups: readonly UsageGroup[], coverage: SessionUsage['coverage']): UsageTokens {
  const aggregate = (values: readonly TokenCount[]): TokenCount => {
    const known = values.filter((n): n is number => typeof n === 'number');
    if (known.length > 0) return sumSafeCounts(known);
    return coverage === 'complete' && values.length > 0 && values.every((n) => n === 'not_applicable') ? 'not_applicable' : null;
  };
  const countClass = (key: (typeof usageTokenClasses)[number]) => aggregate(groups.map(({ tokens }) => tokens[key]));
  const totals: UsageTokens = {
    freshInput: countClass('freshInput'), cacheRead: countClass('cacheRead'), output: countClass('output'),
    cacheWrite: aggregate(groups.flatMap(({ tokens }) => {
      const buckets = Object.values(tokens.cacheWriteByRetention ?? {});
      return tokens.cacheWrite === null && buckets.length > 0 ? buckets : [tokens.cacheWrite];
    }))
  };
  const retention = new Map<string, number[]>();
  const reasoning: number[] = [];
  for (const { tokens } of groups) {
    if (tokens.reasoningOutput !== undefined) reasoning.push(tokens.reasoningOutput);
    for (const [key, n] of Object.entries(tokens.cacheWriteByRetention ?? {})) {
      const counts = retention.get(key) ?? [];
      counts.push(n);
      retention.set(key, counts);
    }
  }
  if (reasoning.length > 0) {
    const sum = sumSafeCounts(reasoning);
    if (sum !== null) totals.reasoningOutput = sum;
  }
  const writes = [...retention].flatMap(([key, values]) => {
    const sum = sumSafeCounts(values);
    return sum === null ? [] : [[key, sum] as const];
  });
  if (writes.length > 0) totals.cacheWriteByRetention = Object.fromEntries(writes);
  return totals;
}

export function hasMeasuredUsage(tokens: UsageTokens): boolean {
  return usageTokenClasses.some((key) => typeof tokens[key] === 'number') ||
    tokens.reasoningOutput !== undefined || Object.keys(tokens.cacheWriteByRetention ?? {}).length > 0;
}

export const sessionUsageSchema = z.object({
  coverage: z.enum(['complete', 'partial', 'unavailable']),
  totals: usageTokensSchema, groups: z.array(usageGroupSchema).max(256)
}).strict().superRefine(({ coverage, groups, totals }, ctx) => {
  const derived = deriveUsageTotals(groups, coverage);
  const buckets = Object.entries(totals.cacheWriteByRetention ?? {});
  if ((coverage === 'unavailable' ? groups.length !== 0 : !groups.some(({ tokens, inputTotalCeilingTokens }) => hasMeasuredUsage(tokens) || inputTotalCeilingTokens !== undefined)) ||
      usageTokenClasses.some((key) => totals[key] !== derived[key]) ||
      totals.reasoningOutput !== derived.reasoningOutput ||
      buckets.length !== Object.keys(derived.cacheWriteByRetention ?? {}).length ||
      buckets.some(([key, n]) => derived.cacheWriteByRetention?.[key] !== n)) {
    ctx.addIssue({ code: 'custom', message: 'Usage totals or coverage do not match groups.' });
  }
});
export type BillingKey = z.infer<typeof billingKeySchema>;
export type TokenCount = z.infer<typeof count>;
export type UsageTokens = z.infer<typeof usageTokensSchema>;
export type UsageGroup = z.infer<typeof usageGroupSchema>;
export type SessionUsage = z.infer<typeof sessionUsageSchema>;
