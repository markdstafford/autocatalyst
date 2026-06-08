import { z } from 'zod';

export const probeResourceCollectionPath = '/v1/probe-resources' as const;
export const createProbeResourceSuccessStatusCode = 201 as const;

export const createProbeResourceRequestSchema = z.object({
  value: z.string().min(1)
});

export const probeResourceIdParamsSchema = z.object({
  id: z.string().min(1)
});

export const probeResourceSchema = z.object({
  id: z.string().min(1),
  value: z.string().min(1),
  createdAt: z.string().datetime()
});

export type CreateProbeResourceRequest = z.infer<typeof createProbeResourceRequestSchema>;
export type ProbeResourceIdParams = z.infer<typeof probeResourceIdParamsSchema>;
export type ProbeResource = z.infer<typeof probeResourceSchema>;
