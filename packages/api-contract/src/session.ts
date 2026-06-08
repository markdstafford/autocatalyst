import { z } from 'zod';

import { costSchema, inferenceSettingsSchema, modelIdentitySchema, sessionRoleSchema, tokenBreakdownSchema } from './domain-value-objects.js';

export const sessionOutcomeSchema = z.enum(['succeeded', 'failed', 'cancelled', 'timeout']);

function requireCostTokensMatchSessionTokens<T extends { tokens: unknown; cost: { tokens: unknown } }>(value: T, context: z.RefinementCtx): void {
  try {
    const sessionTokens = tokenBreakdownSchema.parse(value.tokens);
    const costTokens = tokenBreakdownSchema.parse(value.cost.tokens);
    if (JSON.stringify(sessionTokens) !== JSON.stringify(costTokens)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['cost', 'tokens'], message: 'Session tokens and cost tokens must match.' });
    }
  } catch {
    // If tokens can't be parsed, other validators will catch it
  }
}

export const sessionSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  phase: z.string().min(1).nullable(),
  step: z.string().min(1),
  role: sessionRoleSchema,
  round: z.number().int().min(0),
  model: modelIdentitySchema,
  inferenceSettings: inferenceSettingsSchema,
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
  durationMs: z.number().int().min(0).nullable(),
  tokens: tokenBreakdownSchema,
  usageAvailable: z.boolean(),
  assistantTurnCount: z.number().int().min(0),
  toolCallCount: z.number().int().min(0),
  outcome: sessionOutcomeSchema,
  cost: costSchema
}).strict().superRefine(requireCostTokensMatchSessionTokens);

export const createSessionInputSchema = z.object({
  runId: z.string().min(1),
  phase: z.string().min(1).nullable(),
  step: z.string().min(1),
  role: sessionRoleSchema,
  round: z.number().int().min(0),
  model: modelIdentitySchema,
  inferenceSettings: inferenceSettingsSchema,
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
  durationMs: z.number().int().min(0).nullable(),
  tokens: tokenBreakdownSchema,
  usageAvailable: z.boolean(),
  assistantTurnCount: z.number().int().min(0),
  toolCallCount: z.number().int().min(0),
  outcome: sessionOutcomeSchema,
  cost: costSchema
}).strict().superRefine(requireCostTokensMatchSessionTokens);

export type SessionOutcome = z.infer<typeof sessionOutcomeSchema>;
export type Session = z.infer<typeof sessionSchema>;
export type CreateSessionInput = z.infer<typeof createSessionInputSchema>;
