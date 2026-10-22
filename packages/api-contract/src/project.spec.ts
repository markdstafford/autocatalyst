import { describe, expect, it } from 'vitest';

import {
  createProjectRequestSchema,
  createProjectSuccessStatusCode,
  generateOpenApiDocument,
  getProjectSuccessStatusCode,
  listProjectsSuccessStatusCode,
  projectCollectionPath,
  projectIdParamsSchema,
  projectListResponseSchema,
  projectResponseSchema,
  updateProjectRequestSchema,
  updateProjectSuccessStatusCode
} from './index.js';

const validSecretHandle = 'sec_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef';

const validCreate = {
  displayName: 'Autocatalyst',
  repoUrl: 'https://github.com/example/repo',
  hostRepository: { provider: 'github', owner: 'example', name: 'repo', url: 'https://github.com/example/repo' }
};

describe('project contract constants', () => {
  it('exposes collection path and success status codes', () => {
    expect(projectCollectionPath).toBe('/v1/projects');
    expect(createProjectSuccessStatusCode).toBe(201);
    expect(listProjectsSuccessStatusCode).toBe(200);
    expect(getProjectSuccessStatusCode).toBe(200);
    expect(updateProjectSuccessStatusCode).toBe(200);
  });

  it('validates id params strictly', () => {
    expect(projectIdParamsSchema.parse({ id: 'proj_1' }).id).toBe('proj_1');
    expect(() => projectIdParamsSchema.parse({ id: '' })).toThrow();
    expect(() => projectIdParamsSchema.parse({ id: 'proj_1', extra: 1 })).toThrow();
  });
});

describe('createProjectRequestSchema', () => {
  it('accepts a minimal valid request', () => {
    const parsed = createProjectRequestSchema.parse(validCreate);
    expect(parsed.displayName).toBe('Autocatalyst');
  });

  it('accepts settings and credential refs referencing secret handles', () => {
    const parsed = createProjectRequestSchema.parse({
      ...validCreate,
      issueTrackerSetting: { provider: 'jira', projectKey: 'AC', credentialRef: { id: validSecretHandle, purpose: 'issue_tracker' } },
      codeHostSetting: null,
      credentialRefs: [{ id: validSecretHandle, purpose: 'repo' }]
    });
    expect(parsed.credentialRefs?.[0]?.id).toBe(validSecretHandle);
  });

  it('rejects owner, tenant, and workspaceRootOverride', () => {
    expect(() => createProjectRequestSchema.parse({ ...validCreate, owner: { id: 'u', kind: 'human', tenantId: 't' } })).toThrow();
    expect(() => createProjectRequestSchema.parse({ ...validCreate, tenant: 'tenant_1' })).toThrow();
    expect(() => createProjectRequestSchema.parse({ ...validCreate, workspaceRootOverride: '/tmp' })).toThrow();
  });

  it('rejects non-https repository urls', () => {
    for (const repoUrl of ['http://github.com/example/repo', 'file:///etc/passwd', 'ssh://git@github.com/example/repo', 'git://github.com/example/repo']) {
      expect(() => createProjectRequestSchema.parse({ ...validCreate, repoUrl })).toThrow();
    }
  });

  it('rejects non-https hostRepository.url', () => {
    expect(() => createProjectRequestSchema.parse({
      ...validCreate,
      hostRepository: { provider: 'github', owner: 'example', name: 'repo', url: 'http://github.com/example/repo' }
    })).toThrow();
  });

  it('rejects malformed credential references', () => {
    expect(() => createProjectRequestSchema.parse({
      ...validCreate,
      credentialRefs: [{ id: 'not-a-secret-handle', purpose: 'repo' }]
    })).toThrow();
  });
});

describe('updateProjectRequestSchema', () => {
  it('accepts a single allowed field', () => {
    expect(updateProjectRequestSchema.parse({ displayName: 'New name' }).displayName).toBe('New name');
  });

  it('allows null to clear settings', () => {
    expect(updateProjectRequestSchema.parse({ issueTrackerSetting: null }).issueTrackerSetting).toBeNull();
  });

  it('requires at least one allowed field', () => {
    expect(() => updateProjectRequestSchema.parse({})).toThrow();
  });

  it('rejects repoUrl and hostRepository', () => {
    expect(() => updateProjectRequestSchema.parse({ repoUrl: 'https://github.com/example/repo' })).toThrow();
    expect(() => updateProjectRequestSchema.parse({ hostRepository: { provider: 'github', owner: 'example', name: 'repo' } })).toThrow();
  });

  it('rejects owner, tenant, and workspaceRootOverride', () => {
    expect(() => updateProjectRequestSchema.parse({ owner: { id: 'u', kind: 'human', tenantId: 't' } })).toThrow();
    expect(() => updateProjectRequestSchema.parse({ tenant: 'tenant_1' })).toThrow();
    expect(() => updateProjectRequestSchema.parse({ workspaceRootOverride: null })).toThrow();
  });
});

describe('project response schemas', () => {
  const owner = { id: 'user_1', kind: 'human', tenantId: 'tenant_1', displayName: 'Ada' } as const;
  const now = '2026-06-08T00:00:00.000Z';
  const project = {
    id: 'proj_1', owner, tenant: 'tenant_1', displayName: 'Autocatalyst', repoUrl: 'https://github.com/example/repo',
    hostRepository: { provider: 'github', owner: 'example', name: 'repo' },
    workspaceRootOverride: null, issueTrackerSetting: null, codeHostSetting: null, credentialRefs: [],
    createdAt: now, updatedAt: now
  };

  it('parses a single project and a list envelope', () => {
    expect(projectResponseSchema.parse(project).id).toBe('proj_1');
    expect(projectListResponseSchema.parse({ projects: [project] }).projects).toHaveLength(1);
  });
});

describe('openapi document', () => {
  it('registers the project paths, methods, and status codes', () => {
    const doc = generateOpenApiDocument();
    expect(doc.paths['/v1/projects']?.['post']).toBeDefined();
    expect(doc.paths['/v1/projects']?.['get']).toBeDefined();
    expect(doc.paths['/v1/projects/{id}']?.['get']).toBeDefined();
    expect(doc.paths['/v1/projects/{id}']?.['patch']).toBeDefined();

    const post = doc.paths['/v1/projects']?.['post'] as { responses: Record<string, unknown> };
    expect(post.responses[String(createProjectSuccessStatusCode)]).toBeDefined();
    const patch = doc.paths['/v1/projects/{id}']?.['patch'] as { responses: Record<string, unknown> };
    expect(patch.responses[String(updateProjectSuccessStatusCode)]).toBeDefined();
  });
});
