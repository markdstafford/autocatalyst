import { z } from 'zod';

export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    details: z.unknown().optional()
  })
});

export type ErrorResponse = z.infer<typeof errorResponseSchema>;

export const unauthorizedErrorCode = 'unauthorized' as const;
export const validationErrorCode = 'validation_error' as const;
export const notFoundErrorCode = 'not_found' as const;
export const secretStoreLockedErrorCode = 'secret_store_locked' as const;
export const conflictErrorCode = 'conflict' as const;
export const activeRunConflictErrorCode = 'active_run_conflict' as const;
export const intakeRoutingErrorCode = 'intake_routing_error' as const;
export const forbiddenErrorCode = 'forbidden' as const;
