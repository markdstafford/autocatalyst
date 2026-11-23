import { z } from 'zod';
import { priceBasisSchema } from './model-rate-table.js';
import { safeCountSchema, usageTokenClassSchema, requestSizeHintMethodSchema } from './session-usage.js';

const estimateMethodSchema = z.union([requestSizeHintMethodSchema, z.literal('lowest_feasible')]);
const gapIdentity = z.object({
  tokenCount: z.string().regex(/^(0|[1-9]\d*)$/u).nullable(),
  provider: z.string().min(1).optional(), model: z.string().min(1).optional(),
  tokenClass: usageTokenClassSchema.optional()
}).strict();
const gap = gapIdentity.extend({ groupIndex: safeCountSchema.optional() });
const ordinaryGapCode = z.enum([
  'legacy_cache_detail', 'missing_usage', 'partial_usage', 'missing_model', 'missing_rate',
  'missing_cache_retention', 'incompatible_rate', 'amount_overflow'
]);
export const sessionCostGapSchema = z.union([
  gap.extend({ code: ordinaryGapCode }),
  gap.extend({ code: z.literal('missing_request_size'), tokenClass: usageTokenClassSchema }),
  gap.extend({
    code: z.literal('estimated_request_size'), tokenClass: usageTokenClassSchema,
    method: estimateMethodSchema, bandMinRequestInputTokens: safeCountSchema
  })
]);
const rollupGap = gapIdentity.extend({ hasUnknownTokenCount: z.boolean(), sessionCount: safeCountSchema });
const costTotal = z.object({
  knownSubtotalUsd: safeCountSchema.nullable(), basis: priceBasisSchema, complete: z.boolean(),
  sessionCount: safeCountSchema, pricedSessionCount: safeCountSchema, unpricedSessionCount: safeCountSchema,
  gaps: z.array(z.union([
    rollupGap.extend({ code: ordinaryGapCode }),
    rollupGap.extend({ code: z.literal('missing_request_size'), tokenClass: usageTokenClassSchema }),
    rollupGap.extend({
      code: z.literal('estimated_request_size'), tokenClass: usageTokenClassSchema, method: estimateMethodSchema
    })
  ]))
}).strict();
export const sessionCostTotalsSchema = z.object({
  run: costTotal,
  steps: z.array(costTotal.extend({ phase: z.string().min(1).nullable(), step: z.string().min(1) }))
}).strict();
export type SessionCostGap = z.infer<typeof sessionCostGapSchema>;
export type SessionCostTotal = z.infer<typeof costTotal>;
export type SessionCostTotals = z.infer<typeof sessionCostTotalsSchema>;
