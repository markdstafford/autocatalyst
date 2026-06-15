import { z } from 'zod';

import { convergenceCheckpointSchema } from './convergence.js';
import { jsonValueSchema, sessionRoleSchema } from './domain-value-objects.js';

const occurrenceSchema = z.object({
  index: z.number().int().min(0),
  attempt: z.number().int().min(1),
  key: z.string().min(1).optional()
}).strict();

// Accept any JSON value, but when the payload identifies itself as a convergence_review
// checkpoint, validate it against the convergence checkpoint schema.
const checkpointResultSchema = jsonValueSchema.nullable().superRefine((value, ctx) => {
  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as { kind?: unknown }).kind === 'convergence_review'
  ) {
    const parsed = convergenceCheckpointSchema.safeParse(value);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: issue.path,
          message: issue.message
        });
      }
    }
  }
});

export const runStepSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  phase: z.string().min(1).nullable(),
  step: z.string().min(1),
  role: sessionRoleSchema,
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
  durationMs: z.number().int().min(0).nullable(),
  occurrence: occurrenceSchema,
  checkpointResult: checkpointResultSchema
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
