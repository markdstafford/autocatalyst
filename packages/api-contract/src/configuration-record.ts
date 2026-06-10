import { z } from 'zod';
import { secretHandleSchema } from './secret.js';
import { inferenceSettingsSchema, modelIdentitySchema } from './domain-value-objects.js';

export const configurationRecordCollectionPath = '/v1/configuration-records' as const;
export const createConfigurationRecordSuccessStatusCode = 201 as const;
export const deleteConfigurationRecordSuccessStatusCode = 204 as const;

export const configurationRecordIdParamsSchema = z.object({
  id: z.string().min(1)
}).strict();

export const configurationRecordKindSchema = z.literal('provider_profile');

const httpHeaderNameSchema = z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u);

export const runnerEndpointRequiredAlterationsSchema = z.object({
  headerStrip: z.boolean().optional(),
  headerRewrite: z.boolean().optional(),
  inferenceSettings: z.array(z.string().min(1)).optional()
}).strict();

export const runnerEndpointSettingsSchema = z.object({
  baseUrl: z.string().url().optional(),
  authHeaderName: httpHeaderNameSchema.optional(),
  authEnvironmentVariable: z.enum(['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']).optional(),
  requestTimeoutMs: z.number().int().min(1).optional(),
  maxRetries: z.number().int().min(0).optional(),
  headersToStrip: z.array(httpHeaderNameSchema).optional(),
  headersToRewrite: z.record(httpHeaderNameSchema, z.string()).optional(),
  requiredAlterations: runnerEndpointRequiredAlterationsSchema.optional()
}).strict();

export const configurationRecordSettingsSchema = z.object({
  profileName: z.string().min(1),
  credentialSecretHandle: secretHandleSchema.optional(),
  model: modelIdentitySchema.optional(),
  inferenceSettings: inferenceSettingsSchema.optional(),
  endpoint: runnerEndpointSettingsSchema.optional()
}).strict();

export const createConfigurationRecordRequestSchema = z.object({
  kind: configurationRecordKindSchema,
  providerKind: z.string().min(1),
  adapterId: z.string().min(1),
  settings: configurationRecordSettingsSchema
}).strict();

export const updateConfigurationRecordSettingsSchema = z.object({
  profileName: z.string().min(1).optional(),
  credentialSecretHandle: secretHandleSchema.nullable().optional(),
  model: modelIdentitySchema.nullable().optional(),
  inferenceSettings: inferenceSettingsSchema.nullable().optional(),
  endpoint: runnerEndpointSettingsSchema.nullable().optional()
}).strict().refine(
  (value) =>
    value.profileName !== undefined ||
    value.credentialSecretHandle !== undefined ||
    value.model !== undefined ||
    value.inferenceSettings !== undefined ||
    value.endpoint !== undefined,
  { message: 'Settings patch must include at least one field.' }
);

export const updateConfigurationRecordRequestSchema = z.object({
  providerKind: z.string().min(1).optional(),
  adapterId: z.string().min(1).optional(),
  settings: updateConfigurationRecordSettingsSchema.optional()
}).strict().refine(
  (value) => value.providerKind !== undefined || value.adapterId !== undefined || value.settings !== undefined,
  { message: 'At least one mutable field is required.' }
);

export const configurationRecordResponseSchema = z.object({
  id: z.string().min(1),
  kind: configurationRecordKindSchema,
  providerKind: z.string().min(1),
  adapterId: z.string().min(1),
  settings: configurationRecordSettingsSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict();

export const configurationRecordListResponseSchema = z.object({
  records: z.array(configurationRecordResponseSchema)
}).strict();

export type ConfigurationRecordIdParams = z.infer<typeof configurationRecordIdParamsSchema>;
export type ConfigurationRecordKind = z.infer<typeof configurationRecordKindSchema>;
export type RunnerEndpointRequiredAlterations = z.infer<typeof runnerEndpointRequiredAlterationsSchema>;
export type RunnerEndpointSettings = z.infer<typeof runnerEndpointSettingsSchema>;
export type ProviderProfileSettings = z.infer<typeof configurationRecordSettingsSchema>;
export type ConfigurationRecordSettings = ProviderProfileSettings;
export type CreateConfigurationRecordRequest = z.infer<typeof createConfigurationRecordRequestSchema>;
export type UpdateConfigurationRecordRequest = z.infer<typeof updateConfigurationRecordRequestSchema>;
export type ConfigurationRecord = z.infer<typeof configurationRecordResponseSchema>;
export type ConfigurationRecordListResponse = z.infer<typeof configurationRecordListResponseSchema>;
// Re-export InferenceSettings from domain-value-objects for convenience
export type { InferenceSettings } from './domain-value-objects.js';
