import { z } from 'zod';

import { credentialReferenceSchema, nonModelPrincipalSchema, requireTenantMatchesOwner } from './domain-value-objects.js';

const hostRepositorySchema = z.object({
  provider: z.string().min(1),
  owner: z.string().min(1),
  name: z.string().min(1),
  url: z.string().url().optional()
}).strict();

const projectSettingReferenceSchema = z.object({
  provider: z.string().min(1),
  projectKey: z.string().min(1).optional(),
  url: z.string().url().optional(),
  credentialRef: credentialReferenceSchema.optional()
}).strict();

export const projectSchema = z.object({
  id: z.string().min(1),
  owner: nonModelPrincipalSchema,
  tenant: z.string().min(1),
  displayName: z.string().min(1),
  repoUrl: z.string().url(),
  hostRepository: hostRepositorySchema,
  workspaceRootOverride: z.string().nullable(),
  issueTrackerSetting: projectSettingReferenceSchema.nullable(),
  codeHostSetting: projectSettingReferenceSchema.nullable(),
  credentialRefs: z.array(credentialReferenceSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict().superRefine(requireTenantMatchesOwner);

export const createProjectInputSchema = z.object({
  owner: nonModelPrincipalSchema,
  tenant: z.string().min(1),
  displayName: z.string().min(1),
  repoUrl: z.string().url(),
  hostRepository: hostRepositorySchema,
  workspaceRootOverride: z.string().nullable(),
  issueTrackerSetting: projectSettingReferenceSchema.nullable(),
  codeHostSetting: projectSettingReferenceSchema.nullable(),
  credentialRefs: z.array(credentialReferenceSchema)
}).strict().superRefine(requireTenantMatchesOwner);

export type Project = z.infer<typeof projectSchema>;
export type CreateProjectInput = z.infer<typeof createProjectInputSchema>;
