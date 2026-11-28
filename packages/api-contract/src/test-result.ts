import { z } from 'zod';

import { testResultEvidenceSchema } from './domain-value-objects.js';
import { principalSchema } from './principal.js';

export const testResultOutcomeSchema = z.enum(['passed', 'failed', 'blocked', 'inconclusive']);

export const TEST_RESULT_NOTE_MAX_LENGTH = 2_000;
const testingGuideResultRevisionSchema = z.number().int().positive();
export const testResultStateSchema = z.enum(['working', 'final']);
export const testResultItemOutcomeSchema = z.enum(['passed', 'failed']);
export const testResultItemSchema = z.object({
  id: z.string().min(1),
  outcome: testResultItemOutcomeSchema.optional(),
  note: z.string().max(TEST_RESULT_NOTE_MAX_LENGTH).optional(),
  feedbackId: z.string().min(1).optional()
}).strict();

export const testResultSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  tester: principalSchema,
  outcome: testResultOutcomeSchema,
  guideRevision: testingGuideResultRevisionSchema.optional(),
  state: testResultStateSchema.default('final'),
  items: z.array(testResultItemSchema).default([]),
  evidence: testResultEvidenceSchema.optional(),
  feedbackRefs: z.array(z.string().min(1)),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict();

export const createTestResultInputSchema = z.object({
  runId: z.string().min(1),
  tester: principalSchema,
  outcome: testResultOutcomeSchema,
  evidence: testResultEvidenceSchema.optional(),
  feedbackRefs: z.array(z.string().min(1))
}).strict();

export type TestResultOutcome = z.infer<typeof testResultOutcomeSchema>;
export type TestResult = z.infer<typeof testResultSchema>;
export type CreateTestResultInput = z.infer<typeof createTestResultInputSchema>;

export const runTestingGuideResultsPath = '/v1/runs/:id/testing-guide/results' as const;
export const runTestResultsPath = '/v1/runs/:id/test-results' as const;

export const testingGuideResultsSchema = z.object({
  guideRevision: testingGuideResultRevisionSchema,
  state: testResultStateSchema,
  outcome: testResultOutcomeSchema,
  items: z.array(testResultItemSchema),
  testResultId: z.string().min(1).optional()
}).strict();

export const saveTestingGuideResultsRequestSchema = z.object({
  guideRevision: testingGuideResultRevisionSchema,
  items: z.array(z.object({
    id: z.string().min(1),
    outcome: testResultItemOutcomeSchema.nullable(),
    note: z.string().max(TEST_RESULT_NOTE_MAX_LENGTH).nullable()
  }).strict())
}).strict().superRefine(({ items }, ctx) => {
  const seen = new Set<string>();
  for (const [index, item] of items.entries()) {
    if (seen.has(item.id)) {
      ctx.addIssue({ code: 'custom', path: ['items', index, 'id'], message: 'Duplicate test item ID.' });
    }
    seen.add(item.id);
  }
});

export const runTestResultsResponseSchema = z.object({ testResults: z.array(testResultSchema) }).strict();

export type TestResultItem = z.infer<typeof testResultItemSchema>;
export type TestingGuideResults = z.infer<typeof testingGuideResultsSchema>;
export type SaveTestingGuideResultsRequest = z.infer<typeof saveTestingGuideResultsRequestSchema>;
export type RunTestResultsResponse = z.infer<typeof runTestResultsResponseSchema>;
