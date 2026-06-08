import { z } from 'zod';

import { testResultEvidenceSchema } from './domain-value-objects.js';
import { principalSchema } from './principal.js';

export const testResultOutcomeSchema = z.enum(['passed', 'failed', 'blocked', 'inconclusive']);

export const testResultSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  tester: principalSchema,
  outcome: testResultOutcomeSchema,
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
