import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createSecretResponseSchema,
  projectListResponseSchema,
  projectResponseSchema,
  type Principal
} from '@autocatalyst/api-contract';
import { hardcodedDevelopmentPrincipal, type RunUnitOfWork } from '@autocatalyst/core';

import { startControlPlaneServer } from './server.js';

const BEARER_TOKEN = 'integration-token';
const MASTER_SECRET = 'integration-master-secret';

async function withTempDatabasePath(run: (databasePath: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'autocatalyst-project-api-'));
  try {
    await run(join(directory, 'control-plane.sqlite'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const authHeaders = { authorization: `Bearer ${BEARER_TOKEN}` };
const jsonHeaders = { ...authHeaders, 'content-type': 'application/json' };

// A unit of work that advances without doing real work, so a created conversation's
// run does not require live providers.
const noopUnitOfWork: RunUnitOfWork = { run: async () => ({ directive: 'advance' }) };

describe('project management API (end-to-end)', () => {
  it('configures a project from a secret and starts a conversation without direct DB writes', async () => {
    await withTempDatabasePath(async (databasePath) => {
      let principal: Principal = hardcodedDevelopmentPrincipal;
      const handle = await startControlPlaneServer({
        autoDispatch: { enabled: false },
        port: 0,
        databasePath,
        bearerToken: BEARER_TOKEN,
        masterSecret: MASTER_SECRET,
        unitOfWork: noopUnitOfWork,
        resolvePrincipal: async () => principal
      });
      const baseUrl = `http://127.0.0.1:${handle.port}`;

      try {
        // 1. Create a secret and receive a handle.
        const secretResp = await fetch(`${baseUrl}/v1/secrets`, {
          method: 'POST',
          headers: jsonHeaders,
          body: JSON.stringify({ value: 'ghp_integration_token_value' })
        });
        expect(secretResp.status).toBe(201);
        const { handle: secretHandle } = createSecretResponseSchema.parse(await secretResp.json());

        // 2. Create a project referencing the secret handle — only via the API.
        const createResp = await fetch(`${baseUrl}/v1/projects`, {
          method: 'POST',
          headers: jsonHeaders,
          body: JSON.stringify({
            displayName: 'Autocatalyst',
            repoUrl: 'https://github.com/example/repo',
            hostRepository: { provider: 'github', owner: 'example', name: 'repo', url: 'https://github.com/example/repo' },
            issueTrackerSetting: { provider: 'jira', projectKey: 'AC', credentialRef: { id: secretHandle, purpose: 'issue_tracker' } },
            credentialRefs: [{ id: secretHandle, purpose: 'repo' }]
          })
        });
        expect(createResp.status).toBe(201);
        const project = projectResponseSchema.parse(await createResp.json());
        expect(project.owner.tenantId).toBe(hardcodedDevelopmentPrincipal.tenantId);
        expect(project.workspaceRootOverride).toBeNull();
        expect(project.credentialRefs[0]?.id).toBe(secretHandle);

        // 3. Read the project back.
        const getResp = await fetch(`${baseUrl}/v1/projects/${project.id}`, { headers: authHeaders });
        expect(getResp.status).toBe(200);
        expect(projectResponseSchema.parse(await getResp.json()).id).toBe(project.id);

        // 4. Start a conversation bound to the project id.
        const convResp = await fetch(`${baseUrl}/v1/conversations`, {
          method: 'POST',
          headers: jsonHeaders,
          body: JSON.stringify({
            projectId: project.id,
            identity: 'issue-1',
            topic: { title: 'Project API smoke' },
            submission: { kind: 'free_form', body: 'hello', workKind: 'feature' }
          })
        });
        expect(convResp.status).toBe(201);
        const convBody = (await convResp.json()) as { run: { id: string }; conversation: { projectId: string } };
        expect(convBody.run.id).toMatch(/^run_/u);
        expect(convBody.conversation.projectId).toBe(project.id);

        // 5. Authenticate as another tenant and verify it cannot access the
        // first tenant's API-created project. Identity remains server-controlled.
        principal = { id: 'user_other', kind: 'human', tenantId: 'tenant_other', displayName: 'Other' };
        const otherListResp = await fetch(`${baseUrl}/v1/projects`, { headers: authHeaders });
        expect(otherListResp.status).toBe(200);
        expect(projectListResponseSchema.parse(await otherListResp.json()).projects).toEqual([]);

        const crossRead = await fetch(`${baseUrl}/v1/projects/${project.id}`, { headers: authHeaders });
        expect(crossRead.status).toBe(404);
        const crossUpdate = await fetch(`${baseUrl}/v1/projects/${project.id}`, {
          method: 'PATCH',
          headers: jsonHeaders,
          body: JSON.stringify({ displayName: 'hijacked' })
        });
        expect(crossUpdate.status).toBe(404);

        // Create the second tenant's project through HTTP too. The same host
        // repository is allowed in a different tenant.
        const otherCreateResp = await fetch(`${baseUrl}/v1/projects`, {
          method: 'POST',
          headers: jsonHeaders,
          body: JSON.stringify({
            displayName: 'Other tenant project',
            repoUrl: project.repoUrl,
            hostRepository: project.hostRepository
          })
        });
        expect(otherCreateResp.status).toBe(201);
        const otherProject = projectResponseSchema.parse(await otherCreateResp.json());
        expect(otherProject.tenant).toBe('tenant_other');
        expect(otherProject.owner).toEqual(principal);
        const ownListResp = await fetch(`${baseUrl}/v1/projects`, { headers: authHeaders });
        expect(ownListResp.status).toBe(200);
        expect(projectListResponseSchema.parse(await ownListResp.json()).projects.map((p) => p.id))
          .toEqual([otherProject.id]);

        // Return to the original identity: the failed cross-tenant update did
        // not modify its project, and the second tenant's project stays hidden.
        principal = hardcodedDevelopmentPrincipal;
        const listResp = await fetch(`${baseUrl}/v1/projects`, { headers: authHeaders });
        expect(listResp.status).toBe(200);
        expect(projectListResponseSchema.parse(await listResp.json()).projects.map((p) => p.id))
          .toEqual([project.id]);
        const unchangedResp = await fetch(`${baseUrl}/v1/projects/${project.id}`, { headers: authHeaders });
        expect(unchangedResp.status).toBe(200);
        expect(projectResponseSchema.parse(await unchangedResp.json()).displayName).toBe('Autocatalyst');
        expect((await fetch(`${baseUrl}/v1/projects/${otherProject.id}`, { headers: authHeaders })).status).toBe(404);
        expect((await fetch(`${baseUrl}/v1/projects/${otherProject.id}`, {
          method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ displayName: 'hijacked' })
        })).status).toBe(404);
      } finally {
        await handle.close();
      }
    });
  });

  it('enforces validation and conflict rules at the HTTP boundary', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const handle = await startControlPlaneServer({
        autoDispatch: { enabled: false },
        port: 0,
        databasePath,
        bearerToken: BEARER_TOKEN,
        masterSecret: MASTER_SECRET,
        unitOfWork: noopUnitOfWork
      });
      const baseUrl = `http://127.0.0.1:${handle.port}`;

      const base = {
        displayName: 'P',
        repoUrl: 'https://github.com/example/repo',
        hostRepository: { provider: 'github', owner: 'example', name: 'repo' }
      };

      const post = (payload: unknown) => fetch(`${baseUrl}/v1/projects`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify(payload)
      });

      try {
        // Unsafe URL protocols are rejected.
        for (const repoUrl of ['http://github.com/example/repo', 'file:///etc/passwd', 'ssh://git@github.com/example/repo', 'git://github.com/example/repo']) {
          const resp = await post({ ...base, repoUrl });
          expect(resp.status, `repoUrl ${repoUrl}`).toBe(400);
        }

        // Malformed credential reference.
        expect((await post({ ...base, credentialRefs: [{ id: 'not-a-handle', purpose: 'repo' }] })).status).toBe(400);

        // Forbidden server-controlled fields.
        expect((await post({ ...base, owner: { id: 'u', kind: 'human', tenantId: 't' } })).status).toBe(400);
        expect((await post({ ...base, tenant: 'tenant_dev' })).status).toBe(400);
        expect((await post({ ...base, workspaceRootOverride: '/tmp' })).status).toBe(400);

        // Create a project, then a duplicate host-repository binding conflicts.
        const first = await post(base);
        expect(first.status).toBe(201);
        const projectId = projectResponseSchema.parse(await first.json()).id;
        const dup = await post({ ...base, displayName: 'Dup' });
        expect(dup.status).toBe(409);

        // Patch immutability and empty-body rules.
        const immutable = await fetch(`${baseUrl}/v1/projects/${projectId}`, {
          method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ repoUrl: 'https://github.com/example/other' })
        });
        expect(immutable.status).toBe(400);

        const emptyPatch = await fetch(`${baseUrl}/v1/projects/${projectId}`, {
          method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({})
        });
        expect(emptyPatch.status).toBe(400);
      } finally {
        await handle.close();
      }
    });
  });
});
