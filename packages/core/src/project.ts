import type {
  CreateProjectRequest,
  NonModelPrincipal,
  Principal,
  Project,
  UpdateProjectRequest
} from '@autocatalyst/api-contract';

import type { ProjectRepository, UpdateProjectInput } from './domain-repositories.js';

export type ProjectServiceErrorCode = 'forbidden' | 'conflict' | 'not_found';

/**
 * Service-layer error for project use cases. Routes map `code` to an HTTP status:
 * `forbidden` -> 403, `conflict` -> 409, `not_found` -> 404.
 */
export class ProjectServiceError extends Error {
  readonly code: ProjectServiceErrorCode;

  constructor(code: ProjectServiceErrorCode, message: string) {
    super(message);
    this.name = 'ProjectServiceError';
    this.code = code;
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
 * Create a tenant-scoped project. Rejects model principals, enforces a
 * per-tenant uniqueness check on the host repository identity
 * `(hostRepository.provider, hostRepository.owner, hostRepository.name)`, and sets
 * server-controlled fields (`owner`, `tenant`, `workspaceRootOverride: null`).
 */
export async function createProject(
  repository: ProjectRepository,
  input: CreateProjectServiceInput
): Promise<Project> {
  const owner = assertNonModelPrincipal(input.principal, 'create');
  const { request } = input;

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
 */
export async function updateProject(
  repository: ProjectRepository,
  input: UpdateProjectServiceInput
): Promise<Project | null> {
  const owner = assertNonModelPrincipal(input.principal, 'update');
  const { request } = input;

  const update: UpdateProjectInput = {
    ...(request.displayName !== undefined ? { displayName: request.displayName } : {}),
    ...(request.issueTrackerSetting !== undefined ? { issueTrackerSetting: request.issueTrackerSetting } : {}),
    ...(request.codeHostSetting !== undefined ? { codeHostSetting: request.codeHostSetting } : {}),
    ...(request.credentialRefs !== undefined ? { credentialRefs: request.credentialRefs } : {})
  };

  return repository.update(owner.tenantId, input.id, update);
}
