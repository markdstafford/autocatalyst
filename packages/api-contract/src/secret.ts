import { z } from 'zod';

export const secretCollectionPath = '/v1/secrets' as const;
export const createSecretSuccessStatusCode = 201 as const;
export const secretHandlePattern = /^sec_[A-Za-z0-9_-]{32}$/u;

export const secretHandleSchema = z.string().regex(secretHandlePattern);

export const createSecretRequestSchema = z.object({
  value: z.string().min(1)
}).strict();

export const createSecretResponseSchema = z.object({
  handle: secretHandleSchema
}).strict();

export type SecretHandle = z.infer<typeof secretHandleSchema>;
export type CreateSecretRequest = z.infer<typeof createSecretRequestSchema>;
export type CreateSecretResponse = z.infer<typeof createSecretResponseSchema>;
