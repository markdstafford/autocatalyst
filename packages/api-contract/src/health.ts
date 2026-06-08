import { z } from 'zod';

export const degradedHealthStatusCode = 503 as const;

export const dependencyStatusSchema = z.enum(['reachable', 'unreachable']);

export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  database: z.object({
    status: dependencyStatusSchema
  })
});

export type DependencyStatus = z.infer<typeof dependencyStatusSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
