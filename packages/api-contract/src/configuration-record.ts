import { z } from 'zod';
import { secretHandleSchema } from './secret.js';

export const configurationRecordCollectionPath = '/v1/configuration-records' as const;
export const createConfigurationRecordSuccessStatusCode = 201 as const;
export const deleteConfigurationRecordSuccessStatusCode = 204 as const;

export const configurationRecordIdParamsSchema = z.object({
  id: z.string().min(1)
}).strict();

export const configurationRecordKindSchema = z.literal('provider_profile');

export const configurationRecordSettingsSchema = z.object({
  profileName: z.string().min(1),
  credentialSecretHandle: secretHandleSchema.optional()
}).strict();

export const createConfigurationRecordRequestSchema = z.object({
  kind: configurationRecordKindSchema,
  providerKind: z.string().min(1),
  adapterId: z.string().min(1),
  settings: configurationRecordSettingsSchema
}).strict();

export const updateConfigurationRecordSettingsSchema = z.object({
  profileName: z.string().min(1).optional(),
  credentialSecretHandle: secretHandleSchema.nullable().optional()
}).strict();

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
export type ConfigurationRecordSettings = z.infer<typeof configurationRecordSettingsSchema>;
export type CreateConfigurationRecordRequest = z.infer<typeof createConfigurationRecordRequestSchema>;
export type UpdateConfigurationRecordRequest = z.infer<typeof updateConfigurationRecordRequestSchema>;
export type ConfigurationRecord = z.infer<typeof configurationRecordResponseSchema>;
export type ConfigurationRecordListResponse = z.infer<typeof configurationRecordListResponseSchema>;
