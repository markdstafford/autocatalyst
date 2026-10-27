import type {
  CreateProjectRequest,
  NonModelPrincipal,
  Principal,
  Project,
  UpdateProjectRequest
} from '@autocatalyst/api-contract';

import type { ProjectRepository, UpdateProjectInput } from './domain-repositories.js';
import type { SecretExistenceChecker } from './secret.js';

export type ProjectServiceErrorCode =
  | 'forbidden'
  | 'conflict'
  | 'not_found'
  | 'unknown_credential_reference';

/**
 * Safe details for an `unknown_credential_reference` error. Lists the offending
 * credential field paths (e.g. `issueTrackerSetting.credentialRef`, `credentialRefs[1]`)
 * and never carries plaintext secret values or secret handles.
 */
export interface UnknownCredentialReferenceDetails {
  readonly fields: readonly string[];
}

/**
 * Service-layer error for project use cases. Routes map `code` to an HTTP status:
 * `forbidden` -> 403, `conflict` -> 409, `not_found` -> 404,
 * `unknown_credential_reference` -> 422. `details` carries safe field paths for the
 * credential-reference case only.
 */
export class ProjectServiceError extends Error {
  readonly code: ProjectServiceErrorCode;
  readonly details?: UnknownCredentialReferenceDetails;

  constructor(code: ProjectServiceErrorCode, message: string, details?: UnknownCredentialReferenceDetails) {
    super(message);
    this.name = 'ProjectServiceError';
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

/** A credential handle written in a request, paired with the field path that carries it. */
interface WrittenCredentialReference {
  readonly path: string;
  readonly handle: string;
}

/**
 * Enumerate every credential reference supplied by a create request: the issue-tracker
 * and code-host setting refs plus each `credentialRefs[]` entry.
 */
function collectCreateCredentialReferences(request: CreateProjectRequest): WrittenCredentialReference[] {
  const references: WrittenCredentialReference[] = [];
  const issueTrackerRef = request.issueTrackerSetting?.credentialRef;
  if (issueTrackerRef !== undefined) {
    references.push({ path: 'issueTrackerSetting.credentialRef', handle: issueTrackerRef.id });
  }
  const codeHostRef = request.codeHostSetting?.credentialRef;
  if (codeHostRef !== undefined) {
    references.push({ path: 'codeHostSetting.credentialRef', handle: codeHostRef.id });
  }
  (request.credentialRefs ?? []).forEach((reference, index) => {
    references.push({ path: `credentialRefs[${index}]`, handle: reference.id });
  });
  return references;
}

/**
 * Enumerate only the credential references actually present in a patch body. A
 * supplied `null` setting clears it and is skipped; an omitted field is skipped so
 * unrelated edits (e.g. a rename) do not revalidate pre-existing references.
 */
function collectUpdateCredentialReferences(request: UpdateProjectRequest): WrittenCredentialReference[] {
  const references: WrittenCredentialReference[] = [];
  if (request.issueTrackerSetting !== undefined && request.issueTrackerSetting !== null) {
    const reference = request.issueTrackerSetting.credentialRef;
    if (reference !== undefined) {
      references.push({ path: 'issueTrackerSetting.credentialRef', handle: reference.id });
    }
  }
  if (request.codeHostSetting !== undefined && request.codeHostSetting !== null) {
    const reference = request.codeHostSetting.credentialRef;
    if (reference !== undefined) {
      references.push({ path: 'codeHostSetting.credentialRef', handle: reference.id });
    }
  }
  if (request.credentialRefs !== undefined) {
    request.credentialRefs.forEach((reference, index) => {
      references.push({ path: `credentialRefs[${index}]`, handle: reference.id });
    });
  }
  return references;
}

/**
 * Verify every written credential reference names an existing secret. Duplicate
 * handles are checked once for efficiency, but every offending field path is
 * reported. Throws `unknown_credential_reference` with all missing paths; never
 * reaches persistence on failure. No-op (and no existence calls) when empty.
 */
async function assertCredentialReferencesExist(
  secretExistence: SecretExistenceChecker,
  references: readonly WrittenCredentialReference[]
): Promise<void> {
  if (references.length === 0) {
    return;
  }
  const uniqueHandles = [...new Set(references.map((reference) => reference.handle))];
  const existenceByHandle = new Map<string, boolean>();
  await Promise.all(
    uniqueHandles.map(async (handle) => {
      existenceByHandle.set(handle, await secretExistence.hasSecret(handle));
    })
  );
  const missingFields = references
    .filter((reference) => existenceByHandle.get(reference.handle) === false)
    .map((reference) => reference.path);
  if (missingFields.length > 0) {
    throw new ProjectServiceError(
      'unknown_credential_reference',
      'Project credential references must point at existing secrets.',
      { fields: missingFields }
    );
  }
}

export interface CreateProjectServiceInput {
  readonly principal: Principal;
  readonly request: CreateProjectRequest;
}

export interface ListProjectsServiceInput {
  readonly principal: Principal;
}

export interface GetProjectServiceInput {
  readonly principal: Principal;
  readonly id: string;
}

export interface UpdateProjectServiceInput {
  readonly principal: Principal;
  readonly id: string;
  readonly request: UpdateProjectRequest;
}

function assertNonModelPrincipal(principal: Principal, action: string): NonModelPrincipal {
  if (principal.kind === 'model') {
    throw new ProjectServiceError('forbidden', `Model principals cannot ${action} projects.`);
  }
  return principal as NonModelPrincipal;
}

/**
 * Create a tenant-scoped project. Rejects model principals, verifies every written
 * credential reference names an existing secret (422 `unknown_credential_reference`
 * otherwise), enforces a per-tenant uniqueness check on the host repository identity
 * `(hostRepository.provider, hostRepository.owner, hostRepository.name)`, and sets
 * server-controlled fields (`owner`, `tenant`, `workspaceRootOverride: null`).
 */
export async function createProject(
  repository: ProjectRepository,
  secretExistence: SecretExistenceChecker,
  input: CreateProjectServiceInput
): Promise<Project> {
  const owner = assertNonModelPrincipal(input.principal, 'create');
  const { request } = input;

  await assertCredentialReferencesExist(secretExistence, collectCreateCredentialReferences(request));

  const existing = await repository.list(owner.tenantId);
  const duplicate = existing.some(
    (project) =>
      project.hostRepository.provider === request.hostRepository.provider &&
      project.hostRepository.owner === request.hostRepository.owner &&
      project.hostRepository.name === request.hostRepository.name
  );
  if (duplicate) {
    throw new ProjectServiceError(
      'conflict',
      `A project for host repository '${request.hostRepository.provider}/${request.hostRepository.owner}/${request.hostRepository.name}' already exists in this tenant.`
    );
  }

  return repository.create({
    owner,
    tenant: owner.tenantId,
    displayName: request.displayName,
    repoUrl: request.repoUrl,
    hostRepository: request.hostRepository,
    workspaceRootOverride: null,
    issueTrackerSetting: request.issueTrackerSetting ?? null,
    codeHostSetting: request.codeHostSetting ?? null,
    credentialRefs: request.credentialRefs ?? []
  });
}

/** List the projects owned by the caller's tenant. */
export function listProjects(
  repository: ProjectRepository,
  input: ListProjectsServiceInput
): Promise<readonly Project[]> {
  return repository.list(input.principal.tenantId);
}

/** Read a single project scoped to the caller's tenant; null for missing/cross-tenant ids. */
export function getProject(
  repository: ProjectRepository,
  input: GetProjectServiceInput
): Promise<Project | null> {
  return repository.findById(input.principal.tenantId, input.id);
}

/**
 * Update mutable project fields. Rejects model principals and scopes the update to the
 * caller's tenant; returns null for missing or cross-tenant ids so the route can map to 404.
 * Tenant-scoped existence is checked before credential validation, so a patch that targets
 * a missing or cross-tenant project stays 404 even when it also supplies an unknown handle.
 * Validates only the credential references supplied in this patch (422
 * `unknown_credential_reference` when any is unknown), so unrelated edits such as a
 * rename never revalidate or block on pre-existing dangling references.
 */
export async function updateProject(
  repository: ProjectRepository,
  secretExistence: SecretExistenceChecker,
  input: UpdateProjectServiceInput
): Promise<Project | null> {
  const owner = assertNonModelPrincipal(input.principal, 'update');
  const { request } = input;

  // Missing/cross-tenant ids must stay 404. Resolve the project before any credential
  // existence check so an unknown handle on a nonexistent project cannot mask the 404
  // with a 422.
  const existing = await repository.findById(owner.tenantId, input.id);
  if (existing === null) {
    return null;
  }

  await assertCredentialReferencesExist(secretExistence, collectUpdateCredentialReferences(request));

  const update: UpdateProjectInput = {
    ...(request.displayName !== undefined ? { displayName: request.displayName } : {}),
    ...(request.issueTrackerSetting !== undefined ? { issueTrackerSetting: request.issueTrackerSetting } : {}),
    ...(request.codeHostSetting !== undefined ? { codeHostSetting: request.codeHostSetting } : {}),
    ...(request.credentialRefs !== undefined ? { credentialRefs: request.credentialRefs } : {})
  };

  return repository.update(owner.tenantId, input.id, update);
}
