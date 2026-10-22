import { describe, expect, it, vi } from 'vitest';

import type { CreateProjectRequest, Principal, Project, UpdateProjectRequest } from '@autocatalyst/api-contract';

import type { ProjectRepository } from './domain-repositories.js';
import { ProjectServiceError, createProject, getProject, listProjects, updateProject } from './project.js';

const humanPrincipal: Principal = { id: 'user_1', kind: 'human', tenantId: 'tenant_1', displayName: 'Ada' };
const modelPrincipal: Principal = { id: 'model_1', kind: 'model', tenantId: 'tenant_1' };

const now = '2026-06-08T00:00:00.000Z';

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj_1',
    owner: { id: 'user_1', kind: 'human', tenantId: 'tenant_1', displayName: 'Ada' },
    tenant: 'tenant_1',
    displayName: 'Autocatalyst',
    repoUrl: 'https://github.com/example/repo',
    hostRepository: { provider: 'github', owner: 'example', name: 'repo' },
    workspaceRootOverride: null,
    issueTrackerSetting: null,
    codeHostSetting: null,
    credentialRefs: [],
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function makeRepository(overrides: Partial<ProjectRepository> = {}): ProjectRepository {
  return {
    create: vi.fn(async (input) => makeProject({ owner: input.owner, tenant: input.tenant, displayName: input.displayName, repoUrl: input.repoUrl, hostRepository: input.hostRepository, workspaceRootOverride: input.workspaceRootOverride, issueTrackerSetting: input.issueTrackerSetting, codeHostSetting: input.codeHostSetting, credentialRefs: input.credentialRefs })),
    findById: vi.fn(async () => null) as ProjectRepository['findById'],
    list: vi.fn(async () => []),
    update: vi.fn(async () => makeProject()),
    ...overrides
  };
}

const createRequest: CreateProjectRequest = {
  displayName: 'Autocatalyst',
  repoUrl: 'https://github.com/example/repo',
  hostRepository: { provider: 'github', owner: 'example', name: 'repo' }
};

describe('createProject', () => {
  it('rejects model principals with a forbidden error', async () => {
    const repository = makeRepository();
    await expect(createProject(repository, { principal: modelPrincipal, request: createRequest }))
      .rejects.toMatchObject({ code: 'forbidden' });
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('sets owner and tenant from the principal and workspaceRootOverride to null', async () => {
    const create = vi.fn(async (input) => makeProject(input as Partial<Project>));
    const repository = makeRepository({ create: create as ProjectRepository['create'] });
    await createProject(repository, { principal: humanPrincipal, request: createRequest });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      owner: humanPrincipal,
      tenant: 'tenant_1',
      workspaceRootOverride: null,
      issueTrackerSetting: null,
      codeHostSetting: null,
      credentialRefs: []
    }));
  });

  it('returns 409 conflict when the host repository already exists in the tenant', async () => {
    const repository = makeRepository({ list: vi.fn(async () => [makeProject()]) });
    await expect(createProject(repository, { principal: humanPrincipal, request: createRequest }))
      .rejects.toMatchObject({ code: 'conflict' });
  });

  it('allows the same host repository identity in a different tenant', async () => {
    // list() is scoped to the caller tenant, so an empty list means no duplicate.
    const repository = makeRepository({ list: vi.fn(async () => []) });
    await expect(createProject(repository, { principal: humanPrincipal, request: createRequest })).resolves.toBeDefined();
  });
});

describe('listProjects / getProject', () => {
  it('lists by the caller tenant', async () => {
    const list = vi.fn(async () => [makeProject()]);
    const repository = makeRepository({ list });
    await listProjects(repository, { principal: humanPrincipal });
    expect(list).toHaveBeenCalledWith('tenant_1');
  });

  it('reads scoped by tenant and id', async () => {
    const findById = vi.fn(async () => makeProject()) as ProjectRepository['findById'];
    const repository = makeRepository({ findById });
    await getProject(repository, { principal: humanPrincipal, id: 'proj_1' });
    expect(findById).toHaveBeenCalledWith('tenant_1', 'proj_1');
  });
});

describe('updateProject', () => {
  it('rejects model principals', async () => {
    const repository = makeRepository();
    await expect(updateProject(repository, { principal: modelPrincipal, id: 'proj_1', request: { displayName: 'x' } }))
      .rejects.toBeInstanceOf(ProjectServiceError);
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('passes only present mutable fields and scopes by tenant', async () => {
    const update = vi.fn(async () => makeProject());
    const repository = makeRepository({ update });
    const request: UpdateProjectRequest = { issueTrackerSetting: null };
    await updateProject(repository, { principal: humanPrincipal, id: 'proj_1', request });
    expect(update).toHaveBeenCalledWith('tenant_1', 'proj_1', { issueTrackerSetting: null });
  });

  it('returns null for missing/cross-tenant ids', async () => {
    const repository = makeRepository({ update: vi.fn(async () => null) });
    await expect(updateProject(repository, { principal: humanPrincipal, id: 'proj_missing', request: { displayName: 'x' } }))
      .resolves.toBeNull();
  });
});
