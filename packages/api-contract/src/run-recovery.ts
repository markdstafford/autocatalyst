import { z } from 'zod';

import { runSchema } from './run.js';

export const runRecoveryPath = '/v1/runs/:id/recover' as const;
export const recoverRunSuccessStatusCode = 200 as const;

/** Operator-selectable recovery mode. Omitting the mode applies the recovery policy table. */
export const runRecoveryModeSchema = z.enum(['resume', 'start_over']);

/**
 * Strict recovery request body. The only accepted field is the optional `mode`.
 * A missing body is treated as `{}` by the route before parsing. Unknown fields fail validation.
 */
export const runRecoveryRequestSchema = z.object({
  mode: runRecoveryModeSchema.optional()
}).strict();

export const runRecoveryResponseSchema = z.object({
  run: runSchema,
  mode: runRecoveryModeSchema
}).strict();

export type RunRecoveryMode = z.infer<typeof runRecoveryModeSchema>;
export type RunRecoveryRequest = z.infer<typeof runRecoveryRequestSchema>;
export type RunRecoveryResponse = z.infer<typeof runRecoveryResponseSchema>;
