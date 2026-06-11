import { z } from 'zod';
import { secretHandleSchema } from './secret.js';
import { inferenceSettingsSchema, modelIdentitySchema } from './domain-value-objects.js';

export const configurationRecordCollectionPath = '/v1/configuration-records' as const;
export const createConfigurationRecordSuccessStatusCode = 201 as const;
export const deleteConfigurationRecordSuccessStatusCode = 204 as const;

export const configurationRecordIdParamsSchema = z.object({
  id: z.string().min(1)
}).strict();

export const configurationRecordKindSchema = z.enum(['provider_profile', 'model_routing_table']);

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

export const providerProfileSettingsSchema = z.object({
  profileName: z.string().min(1),
  credentialSecretHandle: secretHandleSchema.optional(),
  model: modelIdentitySchema.optional(),
  inferenceSettings: inferenceSettingsSchema.optional(),
  endpoint: runnerEndpointSettingsSchema.optional()
}).strict();

const modelRoutingTableSettingsSchemaBase = z.object({
  active: z.boolean(),
  entries: z.array(z.unknown()).default([])
}).strict();

export const configurationRecordSettingsSchema = z.union([
  providerProfileSettingsSchema,
  modelRoutingTableSettingsSchemaBase
]);

// --- Update settings schemas ---

export const updateProviderProfileSettingsSchema = z.object({
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

// Keep legacy name for backward compatibility
export const updateConfigurationRecordSettingsSchema = updateProviderProfileSettingsSchema;

const updateModelRoutingTableSettingsSchema = z.object({
  active: z.boolean().optional(),
  entries: z.array(z.unknown()).optional()
}).partial();

// --- Create request schemas ---

const createProviderProfileRequestSchema = z.object({
  tenant: z.string().min(1),
  kind: z.literal('provider_profile'),
  providerKind: z.string().min(1),
  adapterId: z.string().min(1),
  settings: providerProfileSettingsSchema
}).strict();

const createModelRoutingTableRequestSchema = z.object({
  tenant: z.string().min(1),
  kind: z.literal('model_routing_table'),
  settings: modelRoutingTableSettingsSchemaBase
}).strict();

export const createConfigurationRecordRequestSchema = z.discriminatedUnion('kind', [
  createProviderProfileRequestSchema,
  createModelRoutingTableRequestSchema
]);

// --- Update request schemas ---

const updateProviderProfileRequestBaseSchema = z.object({
  kind: z.literal('provider_profile'),
  providerKind: z.string().min(1).optional(),
  adapterId: z.string().min(1).optional(),
  settings: updateProviderProfileSettingsSchema.optional()
}).strict();

const updateModelRoutingTableRequestBaseSchema = z.object({
  kind: z.literal('model_routing_table'),
  settings: updateModelRoutingTableSettingsSchema.optional()
}).strict();

export const updateConfigurationRecordRequestSchema = z.discriminatedUnion('kind', [
  updateProviderProfileRequestBaseSchema,
  updateModelRoutingTableRequestBaseSchema
]).refine(
  (value) => {
    if (value.kind === 'provider_profile') {
      return value.providerKind !== undefined || value.adapterId !== undefined || value.settings !== undefined;
    }
    return value.settings !== undefined;
  },
  { message: 'At least one mutable field is required.' }
);

// --- Response schemas ---

const providerProfileResponseSchema = z.object({
  id: z.string().min(1),
  tenant: z.string().min(1),
  kind: z.literal('provider_profile'),
  providerKind: z.string().min(1),
  adapterId: z.string().min(1),
  settings: providerProfileSettingsSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict();

const modelRoutingTableResponseSchema = z.object({
  id: z.string().min(1),
  tenant: z.string().min(1),
  kind: z.literal('model_routing_table'),
  settings: modelRoutingTableSettingsSchemaBase,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict();

export const configurationRecordResponseSchema = z.discriminatedUnion('kind', [
  providerProfileResponseSchema,
  modelRoutingTableResponseSchema
]);

export const configurationRecordListResponseSchema = z.object({
  records: z.array(configurationRecordResponseSchema)
}).strict();

export type ConfigurationRecordIdParams = z.infer<typeof configurationRecordIdParamsSchema>;
export type ConfigurationRecordKind = z.infer<typeof configurationRecordKindSchema>;
export type RunnerEndpointRequiredAlterations = z.infer<typeof runnerEndpointRequiredAlterationsSchema>;
export type RunnerEndpointSettings = z.infer<typeof runnerEndpointSettingsSchema>;
export type ProviderProfileSettings = z.infer<typeof providerProfileSettingsSchema>;
export type ConfigurationRecordSettings = z.infer<typeof configurationRecordSettingsSchema>;
export type CreateConfigurationRecordRequest = z.infer<typeof createConfigurationRecordRequestSchema>;
export type UpdateConfigurationRecordRequest = z.infer<typeof updateConfigurationRecordRequestSchema>;
export type ConfigurationRecord = z.infer<typeof configurationRecordResponseSchema>;
export type ConfigurationRecordListResponse = z.infer<typeof configurationRecordListResponseSchema>;
// Re-export InferenceSettings from domain-value-objects for convenience
export type { InferenceSettings } from './domain-value-objects.js';
