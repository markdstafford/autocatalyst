import { describe, expect, it, vi } from 'vitest';

import type { CreateProjectRequest, Principal, Project, UpdateProjectRequest } from '@autocatalyst/api-contract';

import type { ProjectRepository } from './domain-repositories.js';
import { ProjectServiceError, createProject, getProject, listProjects, updateProject } from './project.js';
import type { SecretExistenceChecker } from './secret.js';

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

/**
 * Fake secret-existence checker. By default every handle exists; pass a set of
 * known handles to make any other handle dangling. Records every checked handle.
 */
function makeSecretExistence(options: { known?: readonly string[]; all?: boolean } = {}): SecretExistenceChecker & { readonly checked: string[] } {
  const checked: string[] = [];
  const all = options.all ?? options.known === undefined;
  const known = new Set(options.known ?? []);
  return {
    checked,
    hasSecret: vi.fn(async (handle: string) => {
      checked.push(handle);
      return all ? true : known.has(handle);
    })
  };
}

const secHandle = (suffix: string): string => `sec_${suffix.padEnd(32, '0').slice(0, 32)}`;

const createRequest: CreateProjectRequest = {
  displayName: 'Autocatalyst',
  repoUrl: 'https://github.com/example/repo',
  hostRepository: { provider: 'github', owner: 'example', name: 'repo' }
};

describe('createProject', () => {
  it('rejects model principals with a forbidden error', async () => {
    const repository = makeRepository();
    await expect(createProject(repository, makeSecretExistence(), { principal: modelPrincipal, request: createRequest }))
      .rejects.toMatchObject({ code: 'forbidden' });
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('sets owner and tenant from the principal and workspaceRootOverride to null', async () => {
    const create = vi.fn(async (input) => makeProject(input as Partial<Project>));
    const repository = makeRepository({ create: create as ProjectRepository['create'] });
    await createProject(repository, makeSecretExistence(), { principal: humanPrincipal, request: createRequest });
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
    await expect(createProject(repository, makeSecretExistence(), { principal: humanPrincipal, request: createRequest }))
      .rejects.toMatchObject({ code: 'conflict' });
  });

  it('allows the same host repository identity in a different tenant', async () => {
    // list() is scoped to the caller tenant, so an empty list means no duplicate.
    const repository = makeRepository({ list: vi.fn(async () => []) });
    await expect(createProject(repository, makeSecretExistence(), { principal: humanPrincipal, request: createRequest })).resolves.toBeDefined();
  });

  it('validates all three credential locations when they reference existing secrets', async () => {
    const issue = secHandle('issue');
    const code = secHandle('code');
    const repo = secHandle('repo');
    const repository = makeRepository();
    const secretExistence = makeSecretExistence({ known: [issue, code, repo] });
    const request: CreateProjectRequest = {
      ...createRequest,
      issueTrackerSetting: { provider: 'jira', credentialRef: { id: issue, purpose: 'issue_tracker' } },
      codeHostSetting: { provider: 'github', credentialRef: { id: code, purpose: 'code_host' } },
      credentialRefs: [{ id: repo, purpose: 'repo' }]
    };
    await expect(createProject(repository, secretExistence, { principal: humanPrincipal, request })).resolves.toBeDefined();
    expect(secretExistence.checked).toEqual(expect.arrayContaining([issue, code, repo]));
    expect(repository.create).toHaveBeenCalled();
  });

  it('rejects with unknown_credential_reference reporting every missing field path and leaves the repository untouched', async () => {
    const good = secHandle('good');
    const missingIssue = secHandle('missingissue');
    const missingRef = secHandle('missingref');
    const repository = makeRepository();
    const secretExistence = makeSecretExistence({ known: [good] });
    const request: CreateProjectRequest = {
      ...createRequest,
      issueTrackerSetting: { provider: 'jira', credentialRef: { id: missingIssue, purpose: 'issue_tracker' } },
      codeHostSetting: { provider: 'github', credentialRef: { id: good, purpose: 'code_host' } },
      credentialRefs: [{ id: good, purpose: 'repo' }, { id: missingRef, purpose: 'other' }]
    };
    await expect(createProject(repository, secretExistence, { principal: humanPrincipal, request }))
      .rejects.toMatchObject({
        code: 'unknown_credential_reference',
        details: { fields: ['issueTrackerSetting.credentialRef', 'credentialRefs[1]'] }
      });
    expect(repository.create).not.toHaveBeenCalled();
    expect(repository.list).not.toHaveBeenCalled();
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
    await expect(updateProject(repository, makeSecretExistence(), { principal: modelPrincipal, id: 'proj_1', request: { displayName: 'x' } }))
      .rejects.toBeInstanceOf(ProjectServiceError);
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('passes only present mutable fields and scopes by tenant', async () => {
    const update = vi.fn(async () => makeProject());
    const repository = makeRepository({ update });
    const request: UpdateProjectRequest = { issueTrackerSetting: null };
    await updateProject(repository, makeSecretExistence(), { principal: humanPrincipal, id: 'proj_1', request });
    expect(update).toHaveBeenCalledWith('tenant_1', 'proj_1', { issueTrackerSetting: null });
  });

  it('returns null for missing/cross-tenant ids', async () => {
    const repository = makeRepository({ update: vi.fn(async () => null) });
    await expect(updateProject(repository, makeSecretExistence(), { principal: humanPrincipal, id: 'proj_missing', request: { displayName: 'x' } }))
      .resolves.toBeNull();
  });

  it('validates only credential fields supplied by the patch', async () => {
    const codeRef = secHandle('codeonly');
    const repository = makeRepository();
    const secretExistence = makeSecretExistence({ known: [codeRef] });
    const request: UpdateProjectRequest = { codeHostSetting: { provider: 'github', credentialRef: { id: codeRef, purpose: 'code_host' } } };
    await updateProject(repository, secretExistence, { principal: humanPrincipal, id: 'proj_1', request });
    // Only the supplied code-host ref is checked; untouched settings are not revalidated.
    expect(secretExistence.checked).toEqual([codeRef]);
    expect(repository.update).toHaveBeenCalled();
  });

  it('rejects an update whose written credential handle is unknown and leaves the repository untouched', async () => {
    const missing = secHandle('missingpatch');
    const repository = makeRepository();
    const secretExistence = makeSecretExistence({ known: [] });
    const request: UpdateProjectRequest = { credentialRefs: [{ id: missing, purpose: 'repo' }] };
    await expect(updateProject(repository, secretExistence, { principal: humanPrincipal, id: 'proj_1', request }))
      .rejects.toMatchObject({ code: 'unknown_credential_reference', details: { fields: ['credentialRefs[0]'] } });
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('skips existence checks for a rename-only patch so a project with dangling handles can be renamed', async () => {
    const update = vi.fn(async () => makeProject({ displayName: 'Renamed' }));
    const repository = makeRepository({ update });
    const secretExistence = makeSecretExistence({ known: [] });
    const result = await updateProject(repository, secretExistence, { principal: humanPrincipal, id: 'proj_1', request: { displayName: 'Renamed' } });
    expect(result?.displayName).toBe('Renamed');
    expect(secretExistence.hasSecret).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalled();
  });

  it('clearing a setting with null performs no secret check', async () => {
    const repository = makeRepository();
    const secretExistence = makeSecretExistence({ known: [] });
    await updateProject(repository, secretExistence, { principal: humanPrincipal, id: 'proj_1', request: { issueTrackerSetting: null, codeHostSetting: null } });
    expect(secretExistence.hasSecret).not.toHaveBeenCalled();
  });
});
