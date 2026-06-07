import { z } from 'zod';

export const healthResponseSchema = z.object({
  status: z.literal('ok')
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const apiContractPackageName = '@autocatalyst/api-contract' as const;
