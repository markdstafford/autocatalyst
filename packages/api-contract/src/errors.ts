import { z } from 'zod';

export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    details: z.unknown().optional()
  })
});

export type ErrorResponse = z.infer<typeof errorResponseSchema>;
