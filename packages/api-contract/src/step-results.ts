import { z } from 'zod';

import { jsonValueSchema } from './domain-value-objects.js';
import { runnerTerminalDirectiveSchema } from './runner-events.js';

// Mirrors the directive cross-field invariant in runner-events.ts runnerTerminalResultPayloadSchema.
// runner-events.ts cannot be modified; this refinement is intentionally co-located.
function applyTerminalResultRefinement(value: { directive: string; question?: string | undefined; reason?: string | undefined }, ctx: z.RefinementCtx): void {
  if (value.directive === 'needs_input' && value.reason !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reason'], message: 'needs_input terminal results use question, not reason.' });
  }
  if (value.directive === 'fail' && value.question !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['question'], message: 'fail terminal results use reason, not question.' });
  }
}

export const stepResultSchemaIdSchema = z.string().min(1);

export const stepResultContractSchema = z.object({
  step: z.string().min(1),
  schemaId: stepResultSchemaIdSchema
}).strict();

export const runnerTerminalStepResultSchema = z.object({
  directive: runnerTerminalDirectiveSchema,
  question: z.string().min(1).optional(),
  reason: z.string().min(1).optional(),
  result: z.record(jsonValueSchema).optional()
}).strict().superRefine(applyTerminalResultRefinement);

export const runnerTerminalHandoffResultSchema = z.object({
  step: z.string().min(1),
  schemaId: stepResultSchemaIdSchema,
  result: runnerTerminalStepResultSchema
}).strict();

export type RunnerTerminalStepResult = z.infer<typeof runnerTerminalStepResultSchema>;
export type RunnerTerminalHandoffResult = z.infer<typeof runnerTerminalHandoffResultSchema>;
export type StepResultContract = z.infer<typeof stepResultContractSchema>;

export const prFinalizeFindingSchema = z
  .object({
    severity: z.enum(['blocker', 'warning', 'info']),
    summary: z.string().min(1),
    target: z.string().min(1).optional()
  })
  .strict();

export const prFinalizeResultSchema = z
  .object({
    directive: z.enum(['advance', 'revise']),
    reconciledSummary: z.string().optional(),
    titleSubject: z.string().optional(),
    validationSummary: z.array(z.string()).optional(),
    findings: z.array(prFinalizeFindingSchema).default([])
  })
  .strict()
  .superRefine((value, ctx) => {
    // advance + blocker findings is contradictory and must not be guessed; route to correction then fail safely
    if (value.directive === 'advance' && value.findings.some(f => f.severity === 'blocker')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['directive'],
        message: 'advance directive is contradicted by blocker findings; result is ambiguous.'
      });
    }
  });

export type PullRequestFinalizeFinding = z.infer<typeof prFinalizeFindingSchema>;
export type PullRequestFinalizeResult = z.infer<typeof prFinalizeResultSchema>;
