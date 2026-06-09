import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  configurationRecordListResponseSchema,
  configurationRecordResponseSchema,
  createProbeResourceSuccessStatusCode,
  createSecretResponseSchema,
  degradedHealthStatusCode,
  errorResponseSchema,
  healthResponseSchema,
  principalDiagnosticResponseSchema,
  probeResourceCollectionPath,
  probeResourceSchema
} from '@autocatalyst/api-contract';
import {
  buildProviderAdapterKey,
  createExtensionRegistryCatalog,
  hardcodedDevelopmentPrincipal,
  type ControlPlaneService,
  type PolicyDecisionInput,
  type ProviderCompositionResult,
  type RunUnitOfWork
} from '@autocatalyst/core';
import {
  asInternalSqliteDatabase,
  createDrizzleDomainRepositories,
  createSqliteDatabase,
  migrateSqliteDatabase
} from '@autocatalyst/persistence';

import { createControlPlaneServer, startControlPlaneServer } from './server.js';

const BEARER_TOKEN = 'integration-token';
const MASTER_SECRET = 'integration-master-secret';

async function withTempDatabasePath(run: (databasePath: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'autocatalyst-integration-'));
  try {
    await run(join(directory, 'control-plane.sqlite'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('control-plane integration', () => {
  it('checks health, creates and reads a probe resource, and survives restart', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const first = await startControlPlaneServer({
        port: 0,
        databasePath,
        bearerToken: BEARER_TOKEN,
        masterSecret: MASTER_SECRET
      });
      const baseUrl = `http://127.0.0.1:${first.port}`;

      const health = await fetch(`${baseUrl}/health`);
      expect(health.status).toBe(200);
      expect(healthResponseSchema.parse(await health.json())).toEqual({
        status: 'ok',
        database: { status: 'reachable' }
      });

      const create = await fetch(`${baseUrl}${probeResourceCollectionPath}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${BEARER_TOKEN}`
        },
        body: JSON.stringify({ value: 'restart durable' })
      });
      expect(create.status).toBe(createProbeResourceSuccessStatusCode);
      const created = probeResourceSchema.parse(await create.json());

      const read = await fetch(`${baseUrl}${probeResourceCollectionPath}/${created.id}`, {
        headers: { authorization: `Bearer ${BEARER_TOKEN}` }
      });
      expect(read.status).toBe(200);
      expect(probeResourceSchema.parse(await read.json())).toEqual(created);

      await first.close();

      const second = await startControlPlaneServer({
        port: 0,
        databasePath,
        bearerToken: BEARER_TOKEN,
        masterSecret: MASTER_SECRET
      });
      const restartedRead = await fetch(
        `http://127.0.0.1:${second.port}${probeResourceCollectionPath}/${created.id}`,
        { headers: { authorization: `Bearer ${BEARER_TOKEN}` } }
      );
      expect(restartedRead.status).toBe(200);
      expect(probeResourceSchema.parse(await restartedRead.json())).toEqual(created);
      await second.close();
    });
  });

  it('exposes a real SSE stream that remains open until the test closes it', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const handle = await startControlPlaneServer({
        port: 0,
        databasePath,
        bearerToken: BEARER_TOKEN,
        masterSecret: MASTER_SECRET
      });
      const controller = new AbortController();

      try {
        const response = await fetch(`http://127.0.0.1:${handle.port}/v1/events`, {
          signal: controller.signal,
          headers: { authorization: `Bearer ${BEARER_TOKEN}` }
        });

        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toMatch(/^text\/event-stream/u);
        expect(response.headers.get('cache-control')).toContain('no-cache');
        expect(response.body).not.toBeNull();
        controller.abort();
      } finally {
        await handle.close();
      }
    });
  });

  it('returns degraded health when injected health checker reports unreachable', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const app = await createControlPlaneServer({
        databasePath,
        bearerToken: BEARER_TOKEN,
        masterSecret: MASTER_SECRET,
        health: { isDatabaseReachable: async () => false }
      });

      const response = await app.inject({ method: 'GET', url: '/health' });
      expect(response.statusCode).toBe(degradedHealthStatusCode);
      expect(healthResponseSchema.parse(response.json())).toEqual({
        status: 'degraded',
        database: { status: 'unreachable' }
      });

      await app.close();
    });
  });
});

describe('principal and policy integration', () => {
  it('resolves the hardcoded principal and consults policy on authenticated requests', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const policyCalls: PolicyDecisionInput[] = [];
      const app = await createControlPlaneServer({
        databasePath,
        bearerToken: 'integration-token',
        masterSecret: 'integration-master-secret',
        policy: { authorize: async (input) => { policyCalls.push(input); return { allowed: true }; } }
      });

      const response = await app.inject({
        method: 'GET',
        url: '/v1/principal',
        headers: { authorization: 'Bearer integration-token' }
      });
      expect(response.statusCode).toBe(200);
      expect(principalDiagnosticResponseSchema.parse(response.json())).toEqual({
        principal: hardcodedDevelopmentPrincipal
      });
      expect(policyCalls).toHaveLength(1);
      expect(policyCalls[0].action).toBe('principal.diagnostic.read');
      expect(policyCalls[0].principal).toEqual(hardcodedDevelopmentPrincipal);

      await app.close();
    });
  });

  it('rejects unauthenticated requests to /v1/principal with 401', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const app = await createControlPlaneServer({
        databasePath,
        bearerToken: 'integration-token',
        masterSecret: 'integration-master-secret'
      });

      const missingAuth = await app.inject({ method: 'GET', url: '/v1/principal' });
      expect(missingAuth.statusCode).toBe(401);

      const wrongToken = await app.inject({
        method: 'GET',
        url: '/v1/principal',
        headers: { authorization: 'Bearer wrong-token' }
      });
      expect(wrongToken.statusCode).toBe(401);

      await app.close();
    });
  });
});

describe('configuration record CRUD integration', () => {
  it('creates, reads, lists, updates, and deletes configuration records', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const app = await createControlPlaneServer({
        databasePath,
        bearerToken: 'integration-token',
        masterSecret: 'integration-master-secret'
      });
      const authHeaders = { authorization: 'Bearer integration-token' };

      // Create
      const createResp = await app.inject({
        method: 'POST',
        url: '/v1/configuration-records',
        headers: authHeaders,
        payload: {
          kind: 'provider_profile',
          providerKind: 'model_runner',
          adapterId: 'openai',
          settings: { profileName: 'default' }
        }
      });
      expect(createResp.statusCode).toBe(201);
      const created = configurationRecordResponseSchema.parse(createResp.json());
      expect(created.id).toMatch(/^cfg_/u);

      // Read
      const readResp = await app.inject({
        method: 'GET',
        url: `/v1/configuration-records/${created.id}`,
        headers: authHeaders
      });
      expect(readResp.statusCode).toBe(200);
      expect(configurationRecordResponseSchema.parse(readResp.json())).toEqual(created);

      // List
      const listResp = await app.inject({ method: 'GET', url: '/v1/configuration-records', headers: authHeaders });
      expect(listResp.statusCode).toBe(200);
      expect(configurationRecordListResponseSchema.parse(listResp.json()).records).toHaveLength(1);

      // Update
      const patchResp = await app.inject({
        method: 'PATCH',
        url: `/v1/configuration-records/${created.id}`,
        headers: authHeaders,
        payload: { providerKind: 'updated_runner' }
      });
      expect(patchResp.statusCode).toBe(200);
      const updated = configurationRecordResponseSchema.parse(patchResp.json());
      expect(updated.providerKind).toBe('updated_runner');

      // Invalid create
      const badCreate = await app.inject({
        method: 'POST',
        url: '/v1/configuration-records',
        headers: authHeaders,
        payload: { kind: 'provider_profile', providerKind: 'x', adapterId: 'y', settings: { profileName: '' } }
      });
      expect(badCreate.statusCode).toBe(400);
      expect(errorResponseSchema.parse(badCreate.json()).error.code).toBe('validation_error');

      // Delete
      const deleteResp = await app.inject({
        method: 'DELETE',
        url: `/v1/configuration-records/${created.id}`,
        headers: authHeaders
      });
      expect(deleteResp.statusCode).toBe(204);

      // Read after delete
      const afterDelete = await app.inject({
        method: 'GET',
        url: `/v1/configuration-records/${created.id}`,
        headers: authHeaders
      });
      expect(afterDelete.statusCode).toBe(404);

      await app.close();
    });
  });
});

describe('secret handle separation integration', () => {
  it('stores a secret and references it from a config record without exposing the value', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const app = await createControlPlaneServer({
        databasePath,
        bearerToken: 'integration-token',
        masterSecret: 'integration-master-secret'
      });
      const authHeaders = { authorization: 'Bearer integration-token' };
      const secretValue = 'sk-integration-secret';

      // Create secret
      const secretResp = await app.inject({
        method: 'POST',
        url: '/v1/secrets',
        headers: authHeaders,
        payload: { value: secretValue }
      });
      expect(secretResp.statusCode).toBe(201);
      const { handle } = createSecretResponseSchema.parse(secretResp.json());
      expect(handle).toMatch(/^sec_[A-Za-z0-9_-]{32}$/u);
      expect(secretResp.body).not.toContain(secretValue);

      // Create config record referencing the handle
      const configResp = await app.inject({
        method: 'POST',
        url: '/v1/configuration-records',
        headers: authHeaders,
        payload: {
          kind: 'provider_profile',
          providerKind: 'model_runner',
          adapterId: 'openai',
          settings: { profileName: 'default', credentialSecretHandle: handle }
        }
      });
      expect(configResp.statusCode).toBe(201);
      const configRecord = configurationRecordResponseSchema.parse(configResp.json());

      // Read config record - should include handle but NOT secret value
      const readResp = await app.inject({
        method: 'GET',
        url: `/v1/configuration-records/${configRecord.id}`,
        headers: authHeaders
      });
      expect(readResp.statusCode).toBe(200);
      expect(readResp.body).toContain(handle);
      expect(readResp.body).not.toContain(secretValue);

      await app.close();

      // Verify secret value is NOT stored plaintext in the database
      const db = createSqliteDatabase({ path: databasePath });
      const internal = asInternalSqliteDatabase(db);

      const configRows = internal.client
        .prepare('SELECT settings_json FROM configuration_records')
        .all() as Array<{ settings_json: string }>;
      for (const row of configRows) {
        expect(row.settings_json).not.toContain(secretValue);
      }

      const secretRows = internal.client
        .prepare('SELECT ciphertext FROM secrets WHERE handle = ?')
        .all(handle) as Array<{ ciphertext: string }>;
      expect(secretRows).toHaveLength(1);
      expect(secretRows[0].ciphertext).not.toContain(secretValue);

      db.close();
    });
  });
});

describe('provider startup composition integration', () => {
  it('composes registered-and-resolvable providers from persisted configuration records', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const first = await createControlPlaneServer({ databasePath, bearerToken: BEARER_TOKEN, masterSecret: MASTER_SECRET });
      await first.inject({
        method: 'POST',
        url: '/v1/configuration-records',
        headers: { authorization: `Bearer ${BEARER_TOKEN}` },
        payload: { kind: 'provider_profile', providerKind: 'model_runner', adapterId: 'fake-registered-model', settings: { profileName: 'default' } }
      });
      await first.close();

      let result: ProviderCompositionResult | undefined;
      const second = await createControlPlaneServer({
        databasePath,
        bearerToken: BEARER_TOKEN,
        masterSecret: MASTER_SECRET,
        extensionRegistry: createExtensionRegistryCatalog([
          { providerKind: 'model_runner', adapterId: 'fake-registered-model', displayName: 'Fake registered model', capabilities: ['agent_session'] }
        ]),
        providerAdapters: new Map([
          [buildProviderAdapterKey('model_runner', 'fake-registered-model'), () => ({ kind: 'fake-adapter' })]
        ]),
        onProviderComposition: (compositionResult) => { result = compositionResult; }
      });

      expect(result?.warnings).toEqual([]);
      expect(result?.unresolved).toEqual([]);
      expect(result?.composed).toEqual([
        expect.objectContaining({ providerKind: 'model_runner', adapterId: 'fake-registered-model' })
      ]);
      await second.close();
    });
  });

  it('composes unregistered-but-resolvable providers while reporting advisory warnings', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const first = await createControlPlaneServer({ databasePath, bearerToken: BEARER_TOKEN, masterSecret: MASTER_SECRET });
      await first.inject({
        method: 'POST',
        url: '/v1/configuration-records',
        headers: { authorization: `Bearer ${BEARER_TOKEN}` },
        payload: { kind: 'provider_profile', providerKind: 'model_runner', adapterId: 'fake-unregistered-model', settings: { profileName: 'default' } }
      });
      await first.close();

      let result: ProviderCompositionResult | undefined;
      const second = await createControlPlaneServer({
        databasePath,
        bearerToken: BEARER_TOKEN,
        masterSecret: MASTER_SECRET,
        extensionRegistry: createExtensionRegistryCatalog(),
        providerAdapters: new Map([
          [buildProviderAdapterKey('model_runner', 'fake-unregistered-model'), () => ({ kind: 'fake-adapter' })]
        ]),
        onProviderComposition: (compositionResult) => { result = compositionResult; }
      });

      expect(result?.composed).toHaveLength(1);
      expect(result?.warnings).toEqual([
        expect.objectContaining({ code: 'adapter_not_registered', providerKind: 'model_runner', adapterId: 'fake-unregistered-model' })
      ]);
      expect(result?.unresolved).toEqual([]);
      await second.close();
    });
  });

  it('reports registry-listed-but-unresolved providers without runnable bindings', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const first = await createControlPlaneServer({ databasePath, bearerToken: BEARER_TOKEN, masterSecret: MASTER_SECRET });
      await first.inject({
        method: 'POST',
        url: '/v1/configuration-records',
        headers: { authorization: `Bearer ${BEARER_TOKEN}` },
        payload: { kind: 'provider_profile', providerKind: 'model_runner', adapterId: 'fake-unresolved-model', settings: { profileName: 'default' } }
      });
      await first.close();

      let result: ProviderCompositionResult | undefined;
      const second = await createControlPlaneServer({
        databasePath,
        bearerToken: BEARER_TOKEN,
        masterSecret: MASTER_SECRET,
        extensionRegistry: createExtensionRegistryCatalog([
          { providerKind: 'model_runner', adapterId: 'fake-unresolved-model', displayName: 'Fake unresolved', capabilities: [] }
        ]),
        onProviderComposition: (compositionResult) => { result = compositionResult; }
      });

      expect(result?.composed).toEqual([]);
      expect(result?.warnings).toEqual([]);
      expect(result?.unresolved).toEqual([
        expect.objectContaining({ providerKind: 'model_runner', adapterId: 'fake-unresolved-model', reason: 'adapter_not_found' })
      ]);
      await second.close();
    });
  });

  it('returns empty composition arrays when no provider records exist', async () => {
    await withTempDatabasePath(async (databasePath) => {
      let result: ProviderCompositionResult | undefined;
      const app = await createControlPlaneServer({
        databasePath,
        bearerToken: BEARER_TOKEN,
        masterSecret: MASTER_SECRET,
        onProviderComposition: (compositionResult) => { result = compositionResult; }
      });

      expect(result).toEqual({ composed: [], warnings: [], unresolved: [] });
      await app.close();
    });
  });

  it('proves orchestrator ingress end-to-end over the network: POST conversation, GET run, GET steps, SSE event after tick', { timeout: 60000 }, async () => {
    await withTempDatabasePath(async (databasePath) => {
      // Seed a project directly in the SQLite file before starting the server.
      const seedDb = createSqliteDatabase({ path: databasePath });
      await migrateSqliteDatabase(seedDb);
      const seedRepos = createDrizzleDomainRepositories(seedDb);
      const project = await seedRepos.projects.create({
        owner: hardcodedDevelopmentPrincipal,
        tenant: hardcodedDevelopmentPrincipal.tenantId,
        displayName: 'P',
        repoUrl: 'https://example.test',
        hostRepository: { provider: 'github', owner: 'test', name: 'repo' },
        workspaceRootOverride: null,
        issueTrackerSetting: null,
        codeHostSetting: null,
        credentialRefs: []
      });
      seedDb.close();

      const unitOfWork: RunUnitOfWork = { run: async () => ({ directive: 'advance' }) };
      let controlPlane: ControlPlaneService | undefined;

      const handle = await startControlPlaneServer({
        port: 0,
        databasePath,
        bearerToken: BEARER_TOKEN,
        masterSecret: MASTER_SECRET,
        runConcurrency: 2,
        unitOfWork,
        onControlPlaneReady: (service) => {
          controlPlane = service;
        }
      });

      try {
        if (controlPlane === undefined) {
          throw new Error('control-plane service was not exposed via onControlPlaneReady');
        }
        const captured = controlPlane;
        const baseUrl = `http://127.0.0.1:${handle.port}`;
        const authHeaders = { authorization: `Bearer ${BEARER_TOKEN}` };

        // POST /v1/conversations
        const createResp = await fetch(`${baseUrl}/v1/conversations`, {
          method: 'POST',
          headers: { ...authHeaders, 'content-type': 'application/json' },
          body: JSON.stringify({
            projectId: project.id,
            identity: 'test',
            topic: { title: 'T' },
            submission: { kind: 'free_form', body: 'hello', workKind: 'feature' }
          })
        });
        expect(createResp.status).toBe(201);
        const createBody = (await createResp.json()) as { run: { id: string } };
        const runId = createBody.run.id;
        expect(runId).toMatch(/^run_/u);

        // GET /v1/runs/:id
        const getRunResp = await fetch(`${baseUrl}/v1/runs/${runId}`, { headers: authHeaders });
        const getRunBody = (await getRunResp.json()) as { id: string };
        expect(getRunResp.status).toBe(200);
        expect(getRunBody.id).toBe(runId);

        // GET /v1/runs/:id/steps
        const stepsResp = await fetch(`${baseUrl}/v1/runs/${runId}/steps`, { headers: authHeaders });
        const stepsBody = (await stepsResp.json()) as { steps: Array<{ runId: string }> };
        expect(stepsResp.status).toBe(200);
        expect(stepsBody.steps).toBeInstanceOf(Array);
        expect(stepsBody.steps.length).toBeGreaterThanOrEqual(1);
        expect(stepsBody.steps[0].runId).toBe(runId);

        // Open SSE stream BEFORE triggering tick (live bus does not replay).
        const controller = new AbortController();
        const sseResp = await fetch(`${baseUrl}/v1/runs/${runId}/events`, {
          headers: authHeaders,
          signal: controller.signal
        });
        expect(sseResp.status).toBe(200);
        expect(sseResp.headers.get('content-type')).toMatch(/^text\/event-stream/u);

        // Trigger tick AFTER subscribing.
        const tickPromise = captured.tick({
          principal: hardcodedDevelopmentPrincipal,
          tenant: hardcodedDevelopmentPrincipal.tenantId,
          runId
        });

        // Read SSE frames until we find a `run_state_transition` event.
        const reader = sseResp.body?.getReader();
        if (reader === undefined) {
          throw new Error('SSE response has no body reader');
        }
        const decoder = new TextDecoder();
        let buffer = '';
        let payload: { type: string; runId: string; tenant: string } | undefined;

        const findRunStateTransitionFrame = (): boolean => {
          let frameEnd = buffer.indexOf('\n\n');
          while (frameEnd !== -1) {
            const frame = buffer.slice(0, frameEnd);
            buffer = buffer.slice(frameEnd + 2);
            const lines = frame.split('\n');
            const eventLine = lines.find((line) => line.startsWith('event:'));
            const dataLine = lines.find((line) => line.startsWith('data:'));
            if (
              eventLine !== undefined &&
              dataLine !== undefined &&
              /^event:\s*run_state_transition/u.test(eventLine)
            ) {
              payload = JSON.parse(dataLine.slice('data:'.length).trim()) as {
                type: string;
                runId: string;
                tenant: string;
              };
              return true;
            }
            frameEnd = buffer.indexOf('\n\n');
          }
          return false;
        };

        while (payload === undefined) {
          const result = await reader.read();
          if (result.done) break;
          buffer += decoder.decode(result.value, { stream: true });
          if (findRunStateTransitionFrame()) break;
        }
        await tickPromise;

        expect(payload).toBeDefined();
        expect(payload!.type).toBe('run_state_transition');
        expect(payload!.runId).toBe(runId);
        expect(payload!.tenant).toBe(hardcodedDevelopmentPrincipal.tenantId);

        controller.abort();
        await reader.cancel().catch(() => undefined);
      } finally {
        await handle.close();
      }
    });
  });

  it('keeps health public and v1 routes protected after composition is wired', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const app = await createControlPlaneServer({ databasePath, bearerToken: BEARER_TOKEN, masterSecret: MASTER_SECRET });

      const health = await app.inject({ method: 'GET', url: '/health' });
      expect(health.statusCode).toBe(200);

      const protectedRoute = await app.inject({ method: 'GET', url: '/v1/principal' });
      expect(protectedRoute.statusCode).toBe(401);
      expect(errorResponseSchema.parse(protectedRoute.json()).error.code).toBe('unauthorized');

      await app.close();
    });
  });
});
