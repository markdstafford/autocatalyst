import { z } from 'zod';

export const TESTING_GUIDE_DIFF_MAX_BYTES = 200_000;
export const TESTING_GUIDE_INSTRUCTIONS_MAX_LENGTH = 20_000;
export const TESTING_GUIDE_MAX_ITEMS = 30;
export const TESTING_GUIDE_ITEM_TEXT_MAX_LENGTH = 500;
export const TESTING_GUIDE_ITEM_EXPECTED_MAX_LENGTH = 1_000;
export const TESTING_GUIDE_SCHEMA_ID = 'autocatalyst.testing_guide.v1' as const;
export const TESTING_GUIDE_RESULT_FILE = 'testing-guide-result.json' as const;
export const runTestingGuidePath = '/v1/runs/:id/testing-guide' as const;

const authorItemSchema = z.object({
  text: z.string().min(1).max(TESTING_GUIDE_ITEM_TEXT_MAX_LENGTH),
  expected: z.string().max(TESTING_GUIDE_ITEM_EXPECTED_MAX_LENGTH).optional()
}).strict();
const storedItemSchema = authorItemSchema.extend({ id: z.string().min(1) });

export function testingGuideItemMatchKey(item: { readonly text: string; readonly expected?: string | undefined }): string {
  const normalize = (value: string) => value.normalize('NFC').replace(/[\s\p{White_Space}]+/gu, ' ').trim();
  return JSON.stringify(item.expected === undefined
    ? [normalize(item.text)]
    : [normalize(item.text), normalize(item.expected)]);
}

const instructions = z.string().min(1).max(TESTING_GUIDE_INSTRUCTIONS_MAX_LENGTH);
const items = <T extends z.ZodTypeAny>(item: T) => z.array(item).min(1).max(TESTING_GUIDE_MAX_ITEMS);

export const testingGuideAuthorResultSchema = z.object({
  instructions,
  items: items(authorItemSchema)
}).strict().superRefine(({ items }, ctx) => {
  const keys = new Set<string>();
  items.forEach((item, index) => {
    const key = testingGuideItemMatchKey(item);
    if (keys.has(key)) ctx.addIssue({ code: 'custom', path: ['items', index], message: 'Duplicate check.' });
    keys.add(key);
  });
});

export const testingGuideSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  revision: z.number().int().positive(),
  instructions,
  items: items(storedItemSchema),
  createdAt: z.string().datetime()
}).strict();

export type TestingGuideAuthorItem = z.infer<typeof authorItemSchema>;
export type TestingGuideItem = z.infer<typeof storedItemSchema>;
export type TestingGuideAuthorResult = z.infer<typeof testingGuideAuthorResultSchema>;
export type TestingGuide = z.infer<typeof testingGuideSchema>;
