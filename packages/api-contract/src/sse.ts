import { z } from 'zod';

export const eventsStreamPath = '/v1/events' as const;

export const sseHeadersSchema = z.object({
  'content-type': z.string().min(1),
  'cache-control': z.string().min(1),
  connection: z.string().min(1).optional()
});

export type SseHeaders = z.infer<typeof sseHeadersSchema>;
