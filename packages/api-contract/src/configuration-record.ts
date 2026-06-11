import { z } from 'zod';
import { secretHandleSchema } from './secret.js';
import { inferenceSettingsSchema, modelIdentitySchema, sessionRoleSchema } from './domain-value-objects.js';

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

// --- Routing key schemas ---

const stepIdSchema = z.string().min(1);

export const agentModelRouteKeySchema = z.union([
  z.object({
    mode: z.literal('agent'),
    step: stepIdSchema,
    role: sessionRoleSchema
  }).strict(),
  z.object({
    mode: z.literal('agent'),
    step: stepIdSchema,
    defaultForStep: z.literal(true)
  }).strict()
]);

export const directModelRouteKeySchema = z.object({
  mode: z.literal('direct'),
  step: stepIdSchema
}).strict();

export const modelRouteKeySchema = z.union([agentModelRouteKeySchema, directModelRouteKeySchema]);

function modelRouteKeyForComparison(route: z.infer<typeof modelRouteKeySchema>): string {
  if (route.mode === 'direct') return `direct:${route.step}`;
  if ('defaultForStep' in route) return `agent:${route.step}:default`;
  return `agent:${route.step}:role:${(route as { role: string }).role}`;
}

export const modelRoutingEntrySchema = z.object({
  id: z.string().min(1),
  route: modelRouteKeySchema,
  profileId: z.string().min(1),
  enabled: z.boolean().optional()
}).strict();

export const roleDistinctRequirementSchema = z.object({
  step: stepIdSchema,
  mode: z.literal('agent'),
  roles: z.array(sessionRoleSchema).min(1).refine(
    (roles) => new Set(roles).size === roles.length,
    { message: 'Role distinct requirements must not contain duplicate roles.' }
  ),
  distinctBy: z.enum(['model', 'profile'])
}).strict();

function hasDuplicateEnabledRoutes(entries: readonly z.infer<typeof modelRoutingEntrySchema>[]): boolean {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.enabled === false) continue;
    const key = modelRouteKeyForComparison(entry.route);
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

export const modelRoutingTableSettingsSchema = z.object({
  active: z.boolean(),
  tableName: z.string().min(1).optional(),
  version: z.number().int().min(0).optional(),
  entries: z.array(modelRoutingEntrySchema),
  roleDistinctRequirements: z.array(roleDistinctRequirementSchema).optional()
}).strict().refine(
  (value) => !hasDuplicateEnabledRoutes(value.entries),
  { message: 'Routing table must not contain duplicate enabled route keys.', path: ['entries'] }
);

export const modelRoutingErrorCodeSchema = z.enum([
  'routing_table_missing',
  'routing_table_ambiguous',
  'route_not_found',
  'duplicate_route',
  'profile_not_found',
  'profile_incomplete',
  'route_mode_mismatch',
  'adapter_unavailable',
  'credential_reference_invalid',
  'role_distinct_unsatisfied'
]);

export const configurationRecordSettingsSchema = z.union([
  providerProfileSettingsSchema,
  modelRoutingTableSettingsSchema
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

export const updateModelRoutingTableSettingsSchema = z.object({
  active: z.boolean().optional(),
  tableName: z.string().min(1).nullable().optional(),
  version: z.number().int().min(0).nullable().optional(),
  entries: z.array(modelRoutingEntrySchema).optional(),
  roleDistinctRequirements: z.array(roleDistinctRequirementSchema).nullable().optional()
}).strict().refine(
  (value) =>
    value.active !== undefined ||
    value.tableName !== undefined ||
    value.version !== undefined ||
    value.entries !== undefined ||
    value.roleDistinctRequirements !== undefined,
  { message: 'Routing-table settings patch must include at least one field.' }
).refine(
  (value) => value.entries === undefined || !hasDuplicateEnabledRoutes(value.entries),
  { message: 'Routing table must not contain duplicate enabled route keys.', path: ['entries'] }
);

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
  settings: modelRoutingTableSettingsSchema
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
  settings: modelRoutingTableSettingsSchema,
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
export type AgentModelRouteKey = z.infer<typeof agentModelRouteKeySchema>;
export type DirectModelRouteKey = z.infer<typeof directModelRouteKeySchema>;
export type ModelRouteKey = z.infer<typeof modelRouteKeySchema>;
export type ModelRoutingEntry = z.infer<typeof modelRoutingEntrySchema>;
export type RoleDistinctRequirement = z.infer<typeof roleDistinctRequirementSchema>;
export type ModelRoutingTableSettings = z.infer<typeof modelRoutingTableSettingsSchema>;
export type UpdateModelRoutingTableSettings = z.infer<typeof updateModelRoutingTableSettingsSchema>;
export type ModelRoutingErrorCode = z.infer<typeof modelRoutingErrorCodeSchema>;
// Re-export InferenceSettings from domain-value-objects for convenience
export type { InferenceSettings } from './domain-value-objects.js';
