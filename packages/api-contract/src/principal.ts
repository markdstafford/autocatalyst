import { z } from 'zod';

export const principalDiagnosticPath = '/v1/principal' as const;

export const principalKindSchema = z.enum(['human', 'model', 'system']);

export const principalSchema = z.object({
  id: z.string().min(1),
  kind: principalKindSchema,
  tenantId: z.string().min(1),
  displayName: z.string().min(1).optional()
}).strict();

export const principalDiagnosticResponseSchema = z.object({
  principal: principalSchema
}).strict();

export type PrincipalKind = z.infer<typeof principalKindSchema>;
export type Principal = z.infer<typeof principalSchema>;
export type PrincipalDiagnosticResponse = z.infer<typeof principalDiagnosticResponseSchema>;
