import { z } from 'zod';

import { jsonValueSchema } from './domain-value-objects.js';
import { runnerTerminalDirectiveSchema } from './runner-events.js';

const topLevelResultObjectSchema = z.record(jsonValueSchema);

export const stepResultSchemaIdSchema = z.string().min(1);

export const stepResultContractSchema = z.object({
  step: z.string().min(1),
  schemaId: stepResultSchemaIdSchema
}).strict();

export const runnerTerminalStepResultSchema = z.object({
  directive: runnerTerminalDirectiveSchema,
  question: z.string().min(1).optional(),
  reason: z.string().min(1).optional(),
  result: topLevelResultObjectSchema.optional()
}).strict().superRefine((value, ctx) => {
  if (value.directive === 'needs_input' && value.reason !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['reason'],
      message: 'needs_input terminal results use question, not reason.'
    });
  }
  if (value.directive === 'fail' && value.question !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['question'],
      message: 'fail terminal results use reason, not question.'
    });
  }
});

export const runnerTerminalHandoffResultSchema = z.object({
  step: z.string().min(1),
  schemaId: stepResultSchemaIdSchema,
  result: runnerTerminalStepResultSchema
}).strict();

export type RunnerTerminalStepResult = z.infer<typeof runnerTerminalStepResultSchema>;
export type RunnerTerminalHandoffResult = z.infer<typeof runnerTerminalHandoffResultSchema>;
export type StepResultContract = z.infer<typeof stepResultContractSchema>;
