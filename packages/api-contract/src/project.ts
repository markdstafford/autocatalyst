import { z } from 'zod';

import { credentialReferenceSchema, nonModelPrincipalSchema, requireTenantMatchesOwner } from './domain-value-objects.js';
import { secretHandlePattern } from './secret.js';

// ---------------------------------------------------------------------------
// Route + status constants
// ---------------------------------------------------------------------------

export const projectCollectionPath = '/v1/projects' as const;
export const projectResourcePath = '/v1/projects/:id' as const;
export const createProjectSuccessStatusCode = 201 as const;
export const listProjectsSuccessStatusCode = 200 as const;
export const getProjectSuccessStatusCode = 200 as const;
export const updateProjectSuccessStatusCode = 200 as const;

export const projectIdParamsSchema = z.object({
  id: z.string().min(1)
}).strict();

// ---------------------------------------------------------------------------
// Shared value schemas
// ---------------------------------------------------------------------------

/**
 * HTTPS-only URL. Rejects http, file, ssh, git, and any other protocol so a
 * project can never make the server clone from a local file or cleartext source.
 */
export const httpsUrlSchema = z.string().url().refine(
  (value) => {
    try {
      return new URL(value).protocol === 'https:';
    } catch {
      return false;
    }
  },
  { message: 'URL must use the https protocol.' }
);

/**
 * Entity-level host repository shape, reused by the stored/response project schema.
 * `url` is optional and only constrained to be a valid URL here; the API request
 * schema (`hostRepositoryRequestSchema`) additionally enforces https.
 */
export const hostRepositorySchema = z.object({
  provider: z.string().min(1),
  owner: z.string().min(1),
  name: z.string().min(1),
  url: z.string().url().optional()
}).strict();

/**
 * Entity-level setting reference shape (issue tracker / code host), reused by the
 * stored/response project schema.
 */
export const projectSettingReferenceSchema = z.object({
  provider: z.string().min(1),
  projectKey: z.string().min(1).optional(),
  url: z.string().url().optional(),
  credentialRef: credentialReferenceSchema.optional()
}).strict();

/**
 * Credential reference whose `id` must be a valid secret handle. Used anywhere a
 * credential handle appears in an API request (settings or top-level credentialRefs).
 * Existence and tenant ownership of the secret are intentionally out of scope.
 */
export const secretBackedCredentialReferenceSchema = credentialReferenceSchema.extend({
  id: z.string().regex(secretHandlePattern)
});

/** Host repository as supplied in an API request: `url`, when present, must be https. */
export const hostRepositoryRequestSchema = z.object({
  provider: z.string().min(1),
  owner: z.string().min(1),
  name: z.string().min(1),
  url: httpsUrlSchema.optional()
}).strict();

/** Setting reference as supplied in an API request: https url + secret-handle credential ref. */
export const projectSettingReferenceRequestSchema = z.object({
  provider: z.string().min(1),
  projectKey: z.string().min(1).optional(),
  url: httpsUrlSchema.optional(),
  credentialRef: secretBackedCredentialReferenceSchema.optional()
}).strict();

// ---------------------------------------------------------------------------
// Entity (stored / response) schema
// ---------------------------------------------------------------------------

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

/**
 * Persistence-facing create input. Intentionally permissive about URL protocol so
 * internal seed helpers and existing callers can create projects with non-https
 * repo URLs (e.g. file://). The API boundary uses `createProjectRequestSchema`.
 */
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

// ---------------------------------------------------------------------------
// API request schemas
// ---------------------------------------------------------------------------

/**
 * Strict create request. `owner`, `tenant`, and `workspaceRootOverride` are
 * server-controlled and therefore rejected as unknown keys (400). Repository URLs
 * must be https; credential references must be secret handles.
 */
export const createProjectRequestSchema = z.object({
  displayName: z.string().min(1),
  repoUrl: httpsUrlSchema,
  hostRepository: hostRepositoryRequestSchema,
  issueTrackerSetting: projectSettingReferenceRequestSchema.nullable().optional(),
  codeHostSetting: projectSettingReferenceRequestSchema.nullable().optional(),
  credentialRefs: z.array(secretBackedCredentialReferenceSchema).optional()
}).strict();

/**
 * Strict partial update request. Only mutable fields are allowed; `repoUrl` and
 * `hostRepository` are immutable and `owner`/`tenant`/`workspaceRootOverride` remain
 * forbidden, so any of them produce a 400. At least one allowed field is required.
 * Explicit `null` clears a setting.
 */
export const updateProjectRequestSchema = z.object({
  displayName: z.string().min(1).optional(),
  issueTrackerSetting: projectSettingReferenceRequestSchema.nullable().optional(),
  codeHostSetting: projectSettingReferenceRequestSchema.nullable().optional(),
  credentialRefs: z.array(secretBackedCredentialReferenceSchema).optional()
}).strict().refine(
  (value) =>
    value.displayName !== undefined ||
    value.issueTrackerSetting !== undefined ||
    value.codeHostSetting !== undefined ||
    value.credentialRefs !== undefined,
  { message: 'Update must include at least one of displayName, issueTrackerSetting, codeHostSetting, credentialRefs.' }
);

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

export const projectResponseSchema = projectSchema;

export const projectListResponseSchema = z.object({
  projects: z.array(projectSchema)
}).strict();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Project = z.infer<typeof projectSchema>;
export type CreateProjectInput = z.infer<typeof createProjectInputSchema>;
export type ProjectIdParams = z.infer<typeof projectIdParamsSchema>;
export type HostRepository = z.infer<typeof hostRepositorySchema>;
export type ProjectSettingReference = z.infer<typeof projectSettingReferenceSchema>;
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;
export type UpdateProjectRequest = z.infer<typeof updateProjectRequestSchema>;
export type ProjectResponse = z.infer<typeof projectResponseSchema>;
export type ProjectListResponse = z.infer<typeof projectListResponseSchema>;
