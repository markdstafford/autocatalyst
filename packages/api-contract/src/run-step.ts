import { z } from 'zod';

import { sessionRoleSchema } from './domain-value-objects.js';

const occurrenceSchema = z.object({
  index: z.number().int().min(0),
  attempt: z.number().int().min(1),
  key: z.string().min(1).optional()
}).strict();

export const runStepSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  phase: z.string().min(1).nullable(),
  step: z.string().min(1),
  role: sessionRoleSchema,
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
  durationMs: z.number().int().min(0).nullable(),
  occurrence: occurrenceSchema
}).strict();

export const createRunStepInputSchema = z.object({
  runId: z.string().min(1),
  phase: z.string().min(1).nullable(),
  step: z.string().min(1),
  role: sessionRoleSchema,
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
  durationMs: z.number().int().min(0).nullable(),
  occurrence: occurrenceSchema
}).strict();

export const runStepsPath = '/v1/runs/:id/steps' as const;
export const listRunStepsSuccessStatusCode = 200 as const;

export const runStepListResponseSchema = z.object({ steps: z.array(runStepSchema) }).strict();

export type RunStep = z.infer<typeof runStepSchema>;
export type CreateRunStepInput = z.infer<typeof createRunStepInputSchema>;
export type RunStepListResponse = z.infer<typeof runStepListResponseSchema>;
