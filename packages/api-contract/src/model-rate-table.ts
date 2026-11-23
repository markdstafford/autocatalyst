import { z } from 'zod';
import { billingKeySchema, safeCountSchema } from './session-usage.js';

export const priceBasisSchema = z.literal('api_list_price');
const effectiveAt = z.string().datetime({ precision: 3 }).refine(
  (value) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value,
  'Expected a canonical UTC instant with millisecond precision.'
);
const slot = billingKeySchema.extend({ effectiveAt });
const correctsId = z.string().min(1);
const band = z.object({
  minRequestInputTokens: safeCountSchema,
  rates: z.object({
    freshInput: safeCountSchema, cacheRead: safeCountSchema, output: safeCountSchema,
    cacheWrite: z.union([
      z.literal('not_applicable'), safeCountSchema,
      z.object({ '5m': safeCountSchema, '1h': safeCountSchema }).strict()
    ])
  }).strict()
}).strict();
const set = slot.extend({
  action: z.literal('set'), correctsId: correctsId.optional(),
  basis: priceBasisSchema.optional(), contextLimitTokens: safeCountSchema.min(1).optional(),
  bands: z.array(band).min(1).refine(
    (bands) => bands[0]?.minRequestInputTokens === 0 && bands.every((entry, i) =>
      i === 0 || entry.minRequestInputTokens > bands[i - 1]!.minRequestInputTokens),
    'Bands must start at zero and increase strictly.'
  )
});
const retract = slot.extend({ action: z.literal('retract'), correctsId });
export const modelRatePublicationSchema = z.discriminatedUnion('action', [set, retract]);
export const modelRateSettingsSchema = z.discriminatedUnion('action', [
  set.extend({ revision: safeCountSchema.min(1), basis: priceBasisSchema }),
  retract.extend({ revision: safeCountSchema.min(1) })
]);

export type ModelRateBand = z.infer<typeof band>;
export type ModelRatePublication = z.infer<typeof modelRatePublicationSchema>;
export type ModelRateSettings = z.infer<typeof modelRateSettingsSchema>;
