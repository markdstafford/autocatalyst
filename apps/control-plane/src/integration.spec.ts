import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

import { describe, expect, it } from 'vitest';

import {
  configurationRecordListResponseSchema,
  configurationRecordResponseSchema,
  createProbeResourceSuccessStatusCode,
  createSecretResponseSchema,
  degradedHealthStatusCode,
  errorResponseSchema,
  feedbackSchema,
  healthResponseSchema,
  principalDiagnosticResponseSchema,
  probeResourceCollectionPath,
  probeResourceSchema,
  runFeedbackListResponseSchema,
  runListResponseSchema,
  runSchema,
  runSpecResponseSchema
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
  claudeAgentAdapterId,
  claudeProviderKind,
  createClaudeAgentAdapter,
  type ClaudeNativeEvent
} from '@autocatalyst/claude-agent-adapter';
import {
  createOpenAIAgentAdapter
} from '@autocatalyst/openai-agent-adapter';
import type { RunnerEvent } from '@autocatalyst/execution';
import {
  asInternalSqliteDatabase,
  createDrizzleDomainRepositories,
  createSqliteDatabase,
  migrateSqliteDatabase
} from '@autocatalyst/persistence';

import { createFakeLaunchHarness } from './fake-claude-agent-sdk-harness.spec-helper.js';
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
      const first = await startControlPlaneServer({ autoDispatch: { enabled: false },
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

      const second = await startControlPlaneServer({ autoDispatch: { enabled: false },
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
      const handle = await startControlPlaneServer({ autoDispatch: { enabled: false },
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
      const app = await createControlPlaneServer({ autoDispatch: { enabled: false },
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
      const app = await createControlPlaneServer({ autoDispatch: { enabled: false },
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
      const app = await createControlPlaneServer({ autoDispatch: { enabled: false },
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
      const app = await createControlPlaneServer({ autoDispatch: { enabled: false },
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
        payload: { kind: 'provider_profile', providerKind: 'updated_runner' }
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
      const app = await createControlPlaneServer({ autoDispatch: { enabled: false },
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
      const first = await createControlPlaneServer({ autoDispatch: { enabled: false }, databasePath, bearerToken: BEARER_TOKEN, masterSecret: MASTER_SECRET });
      await first.inject({
        method: 'POST',
        url: '/v1/configuration-records',
        headers: { authorization: `Bearer ${BEARER_TOKEN}` },
        payload: { kind: 'provider_profile', providerKind: 'model_runner', adapterId: 'fake-registered-model', settings: { profileName: 'default' } }
      });
      await first.close();

      let result: ProviderCompositionResult | undefined;
      const second = await createControlPlaneServer({ autoDispatch: { enabled: false },
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
      const first = await createControlPlaneServer({ autoDispatch: { enabled: false }, databasePath, bearerToken: BEARER_TOKEN, masterSecret: MASTER_SECRET });
      await first.inject({
        method: 'POST',
        url: '/v1/configuration-records',
        headers: { authorization: `Bearer ${BEARER_TOKEN}` },
        payload: { kind: 'provider_profile', providerKind: 'model_runner', adapterId: 'fake-unregistered-model', settings: { profileName: 'default' } }
      });
      await first.close();

      let result: ProviderCompositionResult | undefined;
      const second = await createControlPlaneServer({ autoDispatch: { enabled: false },
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
      const first = await createControlPlaneServer({ autoDispatch: { enabled: false }, databasePath, bearerToken: BEARER_TOKEN, masterSecret: MASTER_SECRET });
      await first.inject({
        method: 'POST',
        url: '/v1/configuration-records',
        headers: { authorization: `Bearer ${BEARER_TOKEN}` },
        payload: { kind: 'provider_profile', providerKind: 'model_runner', adapterId: 'fake-unresolved-model', settings: { profileName: 'default' } }
      });
      await first.close();

      let result: ProviderCompositionResult | undefined;
      const second = await createControlPlaneServer({ autoDispatch: { enabled: false },
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
      const app = await createControlPlaneServer({ autoDispatch: { enabled: false },
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

      const handle = await startControlPlaneServer({ autoDispatch: { enabled: false },
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

  it('auto-dispatches a created run through its steps to a human gate, streaming live transitions over SSE without tick', { timeout: 60000 }, async () => {
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

      // Controlled runner: park the first (intake) dispatch behind a barrier so the test can
      // open the SSE stream before any post-intake transition is published, then advance each
      // step. This drives the REAL push-primary auto-dispatch path — no tick, no injected
      // dispatch. A chore run walks intake -> implementation.plan -> implementation.build ->
      // implementation.human_review (a human gate), exercising auto-dispatch across consecutive
      // system/ai steps without the spec-authoring completion that feature/enhancement add.
      let releaseFirstDispatch!: () => void;
      const firstDispatchGate = new Promise<void>((resolve) => { releaseFirstDispatch = resolve; });
      let dispatchCount = 0;
      const unitOfWork: RunUnitOfWork = {
        run: async () => {
          dispatchCount += 1;
          if (dispatchCount === 1) {
            await firstDispatchGate;
          }
          return { directive: 'advance' };
        }
      };

      const handle = await startControlPlaneServer({
        autoDispatch: { enabled: true },
        port: 0,
        databasePath,
        bearerToken: BEARER_TOKEN,
        masterSecret: MASTER_SECRET,
        runConcurrency: 2,
        unitOfWork
      });

      try {
        const baseUrl = `http://127.0.0.1:${handle.port}`;
        const authHeaders = { authorization: `Bearer ${BEARER_TOKEN}` };

        // POST /v1/conversations — create returns immediately (fire-and-return) even though the
        // intake step is parked behind the barrier inside the detached auto-dispatch.
        const createResp = await fetch(`${baseUrl}/v1/conversations`, {
          method: 'POST',
          headers: { ...authHeaders, 'content-type': 'application/json' },
          body: JSON.stringify({
            projectId: project.id,
            identity: 'test',
            topic: { title: 'T' },
            submission: { kind: 'free_form', body: 'hello', workKind: 'chore' }
          })
        });
        expect(createResp.status).toBe(201);
        const runId = ((await createResp.json()) as { run: { id: string } }).run.id;
        expect(runId).toMatch(/^run_/u);

        // Subscribe to the run event stream BEFORE releasing the run, so the post-intake
        // transitions are observed live rather than via replay.
        const controller = new AbortController();
        const sseResp = await fetch(`${baseUrl}/v1/runs/${runId}/events`, {
          headers: authHeaders,
          signal: controller.signal
        });
        expect(sseResp.status).toBe(200);
        expect(sseResp.headers.get('content-type')).toMatch(/^text\/event-stream/u);

        // Let the run advance on its own.
        releaseFirstDispatch();

        const reader = sseResp.body?.getReader();
        if (reader === undefined) {
          throw new Error('SSE response has no body reader');
        }
        const decoder = new TextDecoder();
        let buffer = '';
        const transitionToSteps: string[] = [];

        const drainFrames = (): void => {
          let frameEnd = buffer.indexOf('\n\n');
          while (frameEnd !== -1) {
            const frame = buffer.slice(0, frameEnd);
            buffer = buffer.slice(frameEnd + 2);
            const dataLine = frame.split('\n').find((line) => line.startsWith('data:'));
            if (dataLine !== undefined) {
              const event = JSON.parse(dataLine.slice('data:'.length).trim()) as {
                type: string;
                transition?: { toStep?: string };
              };
              if (event.type === 'run_state_transition' && event.transition?.toStep !== undefined) {
                transitionToSteps.push(event.transition.toStep);
              }
            }
            frameEnd = buffer.indexOf('\n\n');
          }
        };

        // Read live frames until the run reaches the human gate.
        while (!transitionToSteps.includes('implementation.human_review')) {
          const result = await reader.read();
          if (result.done) break;
          buffer += decoder.decode(result.value, { stream: true });
          drainFrames();
        }

        // The run auto-advanced across its system/ai steps and paused at the human gate — all
        // observed live over SSE, with no tick and no injected dispatch.
        expect(transitionToSteps).toContain('implementation.plan');
        expect(transitionToSteps).toContain('implementation.human_review');

        controller.abort();
        await reader.cancel().catch(() => undefined);

        // The run rests at the gate reporting waiting_on: human.
        const runResp = await fetch(`${baseUrl}/v1/runs/${runId}`, { headers: authHeaders });
        const runBody = (await runResp.json()) as { currentStep: string; waitingOn?: string };
        expect(runResp.status).toBe(200);
        expect(runBody.currentStep).toBe('implementation.human_review');
        expect(runBody.waitingOn).toBe('human');
      } finally {
        await handle.close();
      }
    });
  });

  it('keeps health public and v1 routes protected after composition is wired', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const app = await createControlPlaneServer({ autoDispatch: { enabled: false }, databasePath, bearerToken: BEARER_TOKEN, masterSecret: MASTER_SECRET });

      const health = await app.inject({ method: 'GET', url: '/health' });
      expect(health.statusCode).toBe(200);

      const protectedRoute = await app.inject({ method: 'GET', url: '/v1/principal' });
      expect(protectedRoute.statusCode).toBe(401);
      expect(errorResponseSchema.parse(protectedRoute.json()).error.code).toBe('unauthorized');

      await app.close();
    });
  });
});

// ---------------------------------------------------------------------------
// Real Claude-agent dispatch integration: proves the production composition
// (realRunnerDispatch + delegating execution entry point + Claude adapter)
// drives a run end-to-end while never leaking the resolved secret value.
// ---------------------------------------------------------------------------

const CREDENTIAL_VALUE = 'cred-value-that-must-not-leak';
const ENDPOINT_BASE_URL = 'https://gateway.example.test';

const SUCCESS_EVENTS: readonly ClaudeNativeEvent[] = [
  { type: 'assistant', content: 'I will answer the question.' },
  { type: 'tool_use', tool: { name: 'read_file', input: { path: 'README.md' } } },
  {
    type: 'result',
    result: {
      output: JSON.stringify({ status: 'done', answer: 'Integration test result' }),
      total_tokens: 100,
      input_tokens: 50,
      output_tokens: 50
    }
  }
];

interface CapturedLogEntry {
  readonly stream: 'log' | 'info' | 'warn' | 'error';
  readonly text: string;
}

function captureConsole(): { entries: CapturedLogEntry[]; restore: () => void } {
  const entries: CapturedLogEntry[] = [];
  const originals = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console)
  };
  const push = (stream: CapturedLogEntry['stream']) => (...args: unknown[]) => {
    entries.push({
      stream,
      text: args
        .map((arg) => (typeof arg === 'string' ? arg : (() => { try { return JSON.stringify(arg); } catch { return String(arg); } })()))
        .join(' ')
    });
  };
  console.log = push('log');
  console.info = push('info');
  console.warn = push('warn');
  console.error = push('error');
  return {
    entries,
    restore() {
      console.log = originals.log;
      console.info = originals.info;
      console.warn = originals.warn;
      console.error = originals.error;
    }
  };
}

async function seedQuestionProject(databasePath: string): Promise<{ projectId: string }> {
  const seedDb = createSqliteDatabase({ path: databasePath });
  await migrateSqliteDatabase(seedDb);
  const seedRepos = createDrizzleDomainRepositories(seedDb);
  const project = await seedRepos.projects.create({
    owner: hardcodedDevelopmentPrincipal,
    tenant: hardcodedDevelopmentPrincipal.tenantId,
    displayName: 'Real Dispatch Project',
    repoUrl: 'https://example.test',
    hostRepository: { provider: 'github', owner: 'test', name: 'repo' },
    workspaceRootOverride: null,
    issueTrackerSetting: null,
    codeHostSetting: null,
    credentialRefs: []
  });
  seedDb.close();
  return { projectId: project.id };
}

async function createLocalGitRepository(root: string): Promise<string> {
  const repoPath = join(root, 'host-repo');
  await mkdir(repoPath, { recursive: true });
  await execFileAsync('git', ['init', '--initial-branch=main'], { cwd: repoPath });
  await execFileAsync('git', ['config', 'user.email', 'integration@example.test'], { cwd: repoPath });
  await execFileAsync('git', ['config', 'user.name', 'Autocatalyst Integration'], { cwd: repoPath });
  await writeFile(join(repoPath, 'README.md'), '# Local host repository\n');
  await execFileAsync('git', ['add', 'README.md'], { cwd: repoPath });
  await execFileAsync('git', ['commit', '-m', 'initial commit'], { cwd: repoPath });
  return repoPath;
}

async function seedFeatureProject(input: {
  readonly databasePath: string;
  readonly repoUrl: string;
}): Promise<{ projectId: string }> {
  const seedDb = createSqliteDatabase({ path: input.databasePath });
  await migrateSqliteDatabase(seedDb);
  const seedRepos = createDrizzleDomainRepositories(seedDb);
  const project = await seedRepos.projects.create({
    owner: hardcodedDevelopmentPrincipal,
    tenant: hardcodedDevelopmentPrincipal.tenantId,
    displayName: 'Real Feature Dispatch Project',
    repoUrl: input.repoUrl,
    hostRepository: { provider: 'github', owner: 'integration', name: 'host-repo' },
    workspaceRootOverride: null,
    issueTrackerSetting: null,
    codeHostSetting: null,
    credentialRefs: []
  });
  seedDb.close();
  return { projectId: project.id };
}

async function createFeatureRun(
  baseUrl: string,
  authHeaders: Record<string, string>,
  projectId: string
): Promise<string> {
  const createResp = await fetch(`${baseUrl}/v1/conversations`, {
    method: 'POST',
    headers: { ...authHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({
      projectId,
      identity: 'real-feature-dispatch-test',
      topic: { title: 'Fix: Load Project Into Dispatch Context' },
      submission: { kind: 'free_form', body: 'please implement this fix', workKind: 'feature' }
    })
  });
  expect(createResp.status).toBe(201);
  const body = (await createResp.json()) as { run: { id: string } };
  return body.run.id;
}

async function createQuestionRun(
  baseUrl: string,
  authHeaders: Record<string, string>,
  projectId: string
): Promise<string> {
  const createResp = await fetch(`${baseUrl}/v1/conversations`, {
    method: 'POST',
    headers: { ...authHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({
      projectId,
      identity: 'real-dispatch-test',
      topic: { title: 'Real dispatch topic' },
      submission: { kind: 'free_form', body: 'what is the answer?', workKind: 'question' }
    })
  });
  expect(createResp.status).toBe(201);
  const body = (await createResp.json()) as { run: { id: string } };
  return body.run.id;
}

describe('real Claude agent dispatch', () => {
  it(
    'dispatches a run through the production composition, records the launch env, persists events, and never leaks the credential',
    { timeout: 60000 },
    async () => {
      await withTempDatabasePath(async (databasePath) => {
        const { projectId } = await seedQuestionProject(databasePath);
        const harness = createFakeLaunchHarness();
        const logCapture = captureConsole();

        // Pre-create a placeholder server to mint a profile id we'll inject as
        // the defaultProviderProfileId on the real-dispatch server.
        const bootstrap = await createControlPlaneServer({ autoDispatch: { enabled: false },
          databasePath,
          bearerToken: BEARER_TOKEN,
          masterSecret: MASTER_SECRET
        });
        let profileId: string;
        try {
          const inj = await bootstrap.inject({
            method: 'POST',
            url: '/v1/secrets',
            headers: { authorization: `Bearer ${BEARER_TOKEN}` },
            payload: { value: CREDENTIAL_VALUE }
          });
          expect(inj.statusCode).toBe(201);
          const { handle } = createSecretResponseSchema.parse(inj.json());

          const cfgInj = await bootstrap.inject({
            method: 'POST',
            url: '/v1/configuration-records',
            headers: { authorization: `Bearer ${BEARER_TOKEN}` },
            payload: {
              kind: 'provider_profile',
              providerKind: claudeProviderKind,
              adapterId: claudeAgentAdapterId,
              settings: {
                profileName: 'integration-default',
                credentialSecretHandle: handle,
                endpoint: {
                  baseUrl: ENDPOINT_BASE_URL,
                  authEnvironmentVariable: 'ANTHROPIC_AUTH_TOKEN',
                  requestTimeoutMs: 30000,
                  maxRetries: 2,
                  headersToRewrite: { 'x-gateway': 'enabled' }
                }
              }
            }
          });
          expect(cfgInj.statusCode).toBe(201);
          profileId = configurationRecordResponseSchema.parse(cfgInj.json()).id;
        } finally {
          await bootstrap.close();
        }

        let controlPlane: ControlPlaneService | undefined;
        const handle = await startControlPlaneServer({ autoDispatch: { enabled: false },
          port: 0,
          databasePath,
          bearerToken: BEARER_TOKEN,
          masterSecret: MASTER_SECRET,
          runConcurrency: 1,
          realRunnerDispatch: { enabled: true, defaultProviderProfileId: profileId },
          providerAdapters: new Map([
            [
              buildProviderAdapterKey(claudeProviderKind, claudeAgentAdapterId),
              () =>
                createClaudeAgentAdapter({
                  launchClaudeSession: harness.createLaunch(SUCCESS_EVENTS)
                })
            ]
          ]),
          onControlPlaneReady: (service) => { controlPlane = service; }
        });

        try {
          if (controlPlane === undefined) {
            throw new Error('control-plane service was not exposed via onControlPlaneReady');
          }
          const captured = controlPlane;
          const baseUrl = `http://127.0.0.1:${handle.port}`;
          const authHeaders = { authorization: `Bearer ${BEARER_TOKEN}` };

          // Create a run via the public conversations API.
          const runId = await createQuestionRun(baseUrl, authHeaders, projectId);
          const runResp0 = await fetch(`${baseUrl}/v1/runs/${runId}`, { headers: authHeaders });
          const runBody0 = (await runResp0.json()) as { id: string; currentStep: string };
          const initialStep = runBody0.currentStep;

          // Open SSE BEFORE the tick: the retained event store's replay only
          // returns events strictly after a known cursor, so replay with no
          // cursor returns no events. The live subscription is what surfaces
          // events emitted after we open the stream.
          const sseController = new AbortController();
          const eventsResp = await fetch(`${baseUrl}/v1/runs/${runId}/events`, {
            headers: authHeaders,
            signal: sseController.signal
          });
          expect(eventsResp.status).toBe(200);
          expect(eventsResp.headers.get('content-type')).toMatch(/^text\/event-stream/u);

          // Drive the run through tick() AFTER subscribing.
          const tickPromise = captured.tick({
            principal: hardcodedDevelopmentPrincipal,
            tenant: hardcodedDevelopmentPrincipal.tenantId,
            runId
          });

          const reader = eventsResp.body?.getReader();
          if (reader === undefined) throw new Error('SSE body had no reader');
          const decoder = new TextDecoder();
          let buffer = '';
          let sawStateTransition = false;
          let sawRunnerEvent = false;
          const sseDeadline = setTimeout(() => sseController.abort(), 10000);
          try {
            while (!sawStateTransition || !sawRunnerEvent) {
              const result = await reader.read();
              if (result.done) break;
              buffer += decoder.decode(result.value, { stream: true });
              if (/event:\s*run_state_transition/u.test(buffer)) sawStateTransition = true;
              if (/event:\s*runner_assistant_turn|event:\s*runner_tool_activity/u.test(buffer)) sawRunnerEvent = true;
            }
          } catch {
            // aborted via deadline
          } finally {
            clearTimeout(sseDeadline);
            sseController.abort();
            await reader.cancel().catch(() => undefined);
          }
          await tickPromise;
          expect(sawStateTransition).toBe(true);
          expect(sawRunnerEvent).toBe(true);

          // The fake launch must have been invoked exactly once with the
          // configured endpoint and credential surfaced as env vars.
          expect(harness.records).toHaveLength(1);
          const launch = harness.lastRecord();
          expect(launch.env['ANTHROPIC_BASE_URL']).toBe(ENDPOINT_BASE_URL);
          expect(launch.env['ANTHROPIC_AUTH_TOKEN']).toBe(CREDENTIAL_VALUE);
          // No accidental dual-binding of the credential.
          expect(launch.env['ANTHROPIC_API_KEY']).toBeUndefined();
          expect(launch.prompt.length).toBeGreaterThan(0);
          // Req 6: timeout, retry, and custom header rewrite are forwarded as env vars.
          expect(launch.env['API_TIMEOUT_MS']).toBe('30000');
          expect(launch.env['CLAUDE_CODE_MAX_RETRIES']).toBe('2');
          expect(launch.env['ANTHROPIC_CUSTOM_HEADERS']).toBeDefined();
          expect(launch.env['ANTHROPIC_CUSTOM_HEADERS']).toContain('x-gateway');

          // RunStep must be persisted for the executed step.
          const stepsResp = await fetch(`${baseUrl}/v1/runs/${runId}/steps`, { headers: authHeaders });
          expect(stepsResp.status).toBe(200);
          const stepsBody = (await stepsResp.json()) as {
            steps: Array<{ runId: string; step: string; startedAt: string; endedAt: string | null; checkpointResult: unknown }>;
          };
          expect(stepsBody.steps.length).toBeGreaterThanOrEqual(1);
          expect(stepsBody.steps[0].runId).toBe(runId);
          // Req 11: at least one step must carry a non-empty step identifier and startedAt timestamp,
          // demonstrating the step was executed and persisted with meaningful result data.
          expect(stepsBody.steps[0].step.length).toBeGreaterThan(0);
          expect(stepsBody.steps[0].startedAt).toBeTruthy();
          // checkpointResult is populated because the delegating entry point uses
          // scratch_file validation mode: the Claude adapter writes step-result.json to
          // the scratch root, and the entry point reads and validates it, storing the
          // result on the RunStep.
          expect(stepsBody.steps[0]).toHaveProperty('checkpointResult');
          expect(stepsBody.steps[0].checkpointResult).not.toBeNull();

          // Run must have transitioned to either the next step or terminal.
          const runResp = await fetch(`${baseUrl}/v1/runs/${runId}`, { headers: authHeaders });
          expect(runResp.status).toBe(200);
          const runBody = (await runResp.json()) as {
            id: string;
            terminal: boolean;
            currentStep: string;
          };
          expect(runBody.terminal === true || runBody.currentStep !== initialStep).toBe(true);

          // The credential value must NEVER appear in captured stdout/stderr.
          const offendingLogs = logCapture.entries.filter((entry) =>
            entry.text.includes(CREDENTIAL_VALUE)
          );
          expect(offendingLogs).toEqual([]);
        } finally {
          logCapture.restore();
          await handle.close();
        }
      });
    }
  );
});

describe('real Claude agent dispatch - failure paths', () => {
  it('fails the run cleanly when the configured defaultProviderProfileId does not exist', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const { projectId } = await seedQuestionProject(databasePath);
      const harness = createFakeLaunchHarness();

      let controlPlane: ControlPlaneService | undefined;
      const handle = await startControlPlaneServer({ autoDispatch: { enabled: false },
        port: 0,
        databasePath,
        bearerToken: BEARER_TOKEN,
        masterSecret: MASTER_SECRET,
        runConcurrency: 1,
        realRunnerDispatch: {
          enabled: true,
          defaultProviderProfileId: 'cfg_does_not_exist_anywhere'
        },
        providerAdapters: new Map([
          [
            buildProviderAdapterKey(claudeProviderKind, claudeAgentAdapterId),
            () =>
              createClaudeAgentAdapter({
                launchClaudeSession: harness.createLaunch(SUCCESS_EVENTS)
              })
          ]
        ]),
        onControlPlaneReady: (service) => { controlPlane = service; }
      });

      try {
        if (controlPlane === undefined) throw new Error('control-plane service not exposed');
        const captured = controlPlane;
        const baseUrl = `http://127.0.0.1:${handle.port}`;
        const authHeaders = { authorization: `Bearer ${BEARER_TOKEN}` };

        const runId = await createQuestionRun(baseUrl, authHeaders, projectId);

        // Tick must NOT crash — the unit of work converts thrown configuration
        // errors into a 'fail' directive that transitions the run.
        await captured.tick({
          principal: hardcodedDevelopmentPrincipal,
          tenant: hardcodedDevelopmentPrincipal.tenantId,
          runId
        });

        // The adapter must never have been launched: profile resolution failed
        // before the runner could call it.
        expect(harness.records).toEqual([]);

        // Run must be terminal (failed).
        const runResp = await fetch(`${baseUrl}/v1/runs/${runId}`, { headers: authHeaders });
        expect(runResp.status).toBe(200);
        const runBody = (await runResp.json()) as { id: string; terminal: boolean };
        expect(runBody.terminal).toBe(true);
      } finally {
        await handle.close();
      }
    });
  });

  it('fails the run cleanly when the profile references a credentialSecretHandle that does not exist', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const { projectId } = await seedQuestionProject(databasePath);

      // Bootstrap server to create a profile whose credentialSecretHandle
      // references a non-existent secret.
      const bootstrap = await createControlPlaneServer({ autoDispatch: { enabled: false },
        databasePath,
        bearerToken: BEARER_TOKEN,
        masterSecret: MASTER_SECRET
      });
      let profileId: string;
      try {
        // Use a syntactically-valid handle that nothing was stored under.
        // Must match the secretHandleSchema regex: ^sec_[A-Za-z0-9_-]{32}$
        const danglingHandle = 'sec_DanglingHandleThatDoesNotExistAA';
        const cfgInj = await bootstrap.inject({
          method: 'POST',
          url: '/v1/configuration-records',
          headers: { authorization: `Bearer ${BEARER_TOKEN}` },
          payload: {
            kind: 'provider_profile',
            providerKind: claudeProviderKind,
            adapterId: claudeAgentAdapterId,
            settings: {
              profileName: 'broken-credential',
              credentialSecretHandle: danglingHandle,
              endpoint: {
                baseUrl: ENDPOINT_BASE_URL,
                authEnvironmentVariable: 'ANTHROPIC_AUTH_TOKEN'
              }
            }
          }
        });
        expect(cfgInj.statusCode).toBe(201);
        profileId = configurationRecordResponseSchema.parse(cfgInj.json()).id;
      } finally {
        await bootstrap.close();
      }

      const harness = createFakeLaunchHarness();
      let controlPlane: ControlPlaneService | undefined;
      const handle = await startControlPlaneServer({ autoDispatch: { enabled: false },
        port: 0,
        databasePath,
        bearerToken: BEARER_TOKEN,
        masterSecret: MASTER_SECRET,
        runConcurrency: 1,
        realRunnerDispatch: { enabled: true, defaultProviderProfileId: profileId },
        providerAdapters: new Map([
          [
            buildProviderAdapterKey(claudeProviderKind, claudeAgentAdapterId),
            () =>
              createClaudeAgentAdapter({
                launchClaudeSession: harness.createLaunch(SUCCESS_EVENTS)
              })
          ]
        ]),
        onControlPlaneReady: (service) => { controlPlane = service; }
      });

      try {
        if (controlPlane === undefined) throw new Error('control-plane service not exposed');
        const captured = controlPlane;
        const baseUrl = `http://127.0.0.1:${handle.port}`;
        const authHeaders = { authorization: `Bearer ${BEARER_TOKEN}` };

        const runId = await createQuestionRun(baseUrl, authHeaders, projectId);

        await captured.tick({
          principal: hardcodedDevelopmentPrincipal,
          tenant: hardcodedDevelopmentPrincipal.tenantId,
          runId
        });

        // Adapter must never have been launched because credential resolution
        // failed inside connection creation.
        expect(harness.records).toEqual([]);

        const runResp = await fetch(`${baseUrl}/v1/runs/${runId}`, { headers: authHeaders });
        expect(runResp.status).toBe(200);
        const runBody = (await runResp.json()) as { id: string; terminal: boolean };
        expect(runBody.terminal).toBe(true);
      } finally {
        await handle.close();
      }
    });
  });

  // Req 7: configuring headersToStrip (without requiredAlterations) degrades but does not fail the run.
  it('run succeeds with degraded capabilities when headersToStrip is set without requiredAlterations', { timeout: 60000 }, async () => {
    await withTempDatabasePath(async (databasePath) => {
      const { projectId } = await seedQuestionProject(databasePath);
      const harness = createFakeLaunchHarness();

      const bootstrap = await createControlPlaneServer({ autoDispatch: { enabled: false },
        databasePath,
        bearerToken: BEARER_TOKEN,
        masterSecret: MASTER_SECRET
      });
      let profileId: string;
      try {
        const inj = await bootstrap.inject({
          method: 'POST',
          url: '/v1/secrets',
          headers: { authorization: `Bearer ${BEARER_TOKEN}` },
          payload: { value: CREDENTIAL_VALUE }
        });
        expect(inj.statusCode).toBe(201);
        const { handle: secretHandle } = createSecretResponseSchema.parse(inj.json());

        const cfgInj = await bootstrap.inject({
          method: 'POST',
          url: '/v1/configuration-records',
          headers: { authorization: `Bearer ${BEARER_TOKEN}` },
          payload: {
            kind: 'provider_profile',
            providerKind: claudeProviderKind,
            adapterId: claudeAgentAdapterId,
            settings: {
              profileName: 'strip-degraded',
              credentialSecretHandle: secretHandle,
              endpoint: {
                baseUrl: ENDPOINT_BASE_URL,
                authEnvironmentVariable: 'ANTHROPIC_AUTH_TOKEN',
                // headersToStrip without requiredAlterations.headerStrip — should degrade, not fail
                headersToStrip: ['x-remove-me']
              }
            }
          }
        });
        expect(cfgInj.statusCode).toBe(201);
        profileId = configurationRecordResponseSchema.parse(cfgInj.json()).id;
      } finally {
        await bootstrap.close();
      }

      let controlPlane: ControlPlaneService | undefined;
      const handle = await startControlPlaneServer({ autoDispatch: { enabled: false },
        port: 0,
        databasePath,
        bearerToken: BEARER_TOKEN,
        masterSecret: MASTER_SECRET,
        runConcurrency: 1,
        realRunnerDispatch: { enabled: true, defaultProviderProfileId: profileId },
        providerAdapters: new Map([
          [
            buildProviderAdapterKey(claudeProviderKind, claudeAgentAdapterId),
            () =>
              createClaudeAgentAdapter({
                launchClaudeSession: harness.createLaunch(SUCCESS_EVENTS)
              })
          ]
        ]),
        onControlPlaneReady: (service) => { controlPlane = service; }
      });

      try {
        if (controlPlane === undefined) throw new Error('control-plane service not exposed');
        const captured = controlPlane;
        const baseUrl = `http://127.0.0.1:${handle.port}`;
        const authHeaders = { authorization: `Bearer ${BEARER_TOKEN}` };

        const runId = await createQuestionRun(baseUrl, authHeaders, projectId);

        await captured.tick({
          principal: hardcodedDevelopmentPrincipal,
          tenant: hardcodedDevelopmentPrincipal.tenantId,
          runId
        });

        // The adapter MUST have been launched (strip degradation does not block launch).
        expect(harness.records.length).toBeGreaterThanOrEqual(1);

        // Run must have advanced (succeeded despite degradation): either terminal or moved to the next step.
        const runResp = await fetch(`${baseUrl}/v1/runs/${runId}`, { headers: authHeaders });
        expect(runResp.status).toBe(200);
        const runBody = (await runResp.json()) as { id: string; terminal: boolean; currentStep: string };
        expect(runBody.terminal === true || runBody.currentStep !== 'intake').toBe(true);
      } finally {
        await handle.close();
      }
    });
  });

  // Req 13: configuring requiredAlterations.headerStrip fails the run without launching the adapter.
  it('fails the run before launch when requiredAlterations.headerStrip is true (unsupported capability)', { timeout: 60000 }, async () => {
    await withTempDatabasePath(async (databasePath) => {
      const { projectId } = await seedQuestionProject(databasePath);
      const harness = createFakeLaunchHarness();

      const bootstrap = await createControlPlaneServer({ autoDispatch: { enabled: false },
        databasePath,
        bearerToken: BEARER_TOKEN,
        masterSecret: MASTER_SECRET
      });
      let profileId: string;
      try {
        const inj = await bootstrap.inject({
          method: 'POST',
          url: '/v1/secrets',
          headers: { authorization: `Bearer ${BEARER_TOKEN}` },
          payload: { value: CREDENTIAL_VALUE }
        });
        expect(inj.statusCode).toBe(201);
        const { handle: secretHandle } = createSecretResponseSchema.parse(inj.json());

        const cfgInj = await bootstrap.inject({
          method: 'POST',
          url: '/v1/configuration-records',
          headers: { authorization: `Bearer ${BEARER_TOKEN}` },
          payload: {
            kind: 'provider_profile',
            providerKind: claudeProviderKind,
            adapterId: claudeAgentAdapterId,
            settings: {
              profileName: 'required-strip-unsupported',
              credentialSecretHandle: secretHandle,
              endpoint: {
                baseUrl: ENDPOINT_BASE_URL,
                authEnvironmentVariable: 'ANTHROPIC_AUTH_TOKEN',
                headersToStrip: ['x-remove-me'],
                requiredAlterations: { headerStrip: true }
              }
            }
          }
        });
        expect(cfgInj.statusCode).toBe(201);
        profileId = configurationRecordResponseSchema.parse(cfgInj.json()).id;
      } finally {
        await bootstrap.close();
      }

      let controlPlane: ControlPlaneService | undefined;
      const handle = await startControlPlaneServer({ autoDispatch: { enabled: false },
        port: 0,
        databasePath,
        bearerToken: BEARER_TOKEN,
        masterSecret: MASTER_SECRET,
        runConcurrency: 1,
        realRunnerDispatch: { enabled: true, defaultProviderProfileId: profileId },
        providerAdapters: new Map([
          [
            buildProviderAdapterKey(claudeProviderKind, claudeAgentAdapterId),
            () =>
              createClaudeAgentAdapter({
                launchClaudeSession: harness.createLaunch(SUCCESS_EVENTS)
              })
          ]
        ]),
        onControlPlaneReady: (service) => { controlPlane = service; }
      });

      try {
        if (controlPlane === undefined) throw new Error('control-plane service not exposed');
        const captured = controlPlane;
        const baseUrl = `http://127.0.0.1:${handle.port}`;
        const authHeaders = { authorization: `Bearer ${BEARER_TOKEN}` };

        const runId = await createQuestionRun(baseUrl, authHeaders, projectId);

        // Tick must NOT crash — the configuration error propagates as a terminal failure.
        await captured.tick({
          principal: hardcodedDevelopmentPrincipal,
          tenant: hardcodedDevelopmentPrincipal.tenantId,
          runId
        });

        // The adapter must never have been launched: the unsupported required capability
        // throws before the launch seam is reached.
        expect(harness.records).toHaveLength(0);

        // Run must be terminal (failed).
        const runResp = await fetch(`${baseUrl}/v1/runs/${runId}`, { headers: authHeaders });
        expect(runResp.status).toBe(200);
        const runBody = (await runResp.json()) as { id: string; terminal: boolean };
        expect(runBody.terminal).toBe(true);
      } finally {
        await handle.close();
      }
    });
  });

  // Req 14: SDK launch failure (retry exhaustion) terminates the run cleanly without crashing.
  it('terminates the run when the SDK launch throws a retry-exhausted error', { timeout: 60000 }, async () => {
    await withTempDatabasePath(async (databasePath) => {
      const { projectId } = await seedQuestionProject(databasePath);
      const harness = createFakeLaunchHarness();
      const logCapture = captureConsole();

      const bootstrap = await createControlPlaneServer({ autoDispatch: { enabled: false },
        databasePath,
        bearerToken: BEARER_TOKEN,
        masterSecret: MASTER_SECRET
      });
      let profileId: string;
      try {
        const inj = await bootstrap.inject({
          method: 'POST',
          url: '/v1/secrets',
          headers: { authorization: `Bearer ${BEARER_TOKEN}` },
          payload: { value: CREDENTIAL_VALUE }
        });
        expect(inj.statusCode).toBe(201);
        const { handle: secretHandle } = createSecretResponseSchema.parse(inj.json());

        const cfgInj = await bootstrap.inject({
          method: 'POST',
          url: '/v1/configuration-records',
          headers: { authorization: `Bearer ${BEARER_TOKEN}` },
          payload: {
            kind: 'provider_profile',
            providerKind: claudeProviderKind,
            adapterId: claudeAgentAdapterId,
            settings: {
              profileName: 'retry-exhausted',
              credentialSecretHandle: secretHandle,
              endpoint: {
                baseUrl: ENDPOINT_BASE_URL,
                authEnvironmentVariable: 'ANTHROPIC_AUTH_TOKEN'
              }
            }
          }
        });
        expect(cfgInj.statusCode).toBe(201);
        profileId = configurationRecordResponseSchema.parse(cfgInj.json()).id;
      } finally {
        await bootstrap.close();
      }

      let controlPlane: ControlPlaneService | undefined;
      const handle = await startControlPlaneServer({ autoDispatch: { enabled: false },
        port: 0,
        databasePath,
        bearerToken: BEARER_TOKEN,
        masterSecret: MASTER_SECRET,
        runConcurrency: 1,
        realRunnerDispatch: { enabled: true, defaultProviderProfileId: profileId },
        providerAdapters: new Map([
          [
            buildProviderAdapterKey(claudeProviderKind, claudeAgentAdapterId),
            () =>
              createClaudeAgentAdapter({
                launchClaudeSession: harness.createRetryExhaustedLaunch()
              })
          ]
        ]),
        onControlPlaneReady: (service) => { controlPlane = service; }
      });

      try {
        if (controlPlane === undefined) throw new Error('control-plane service not exposed');
        const captured = controlPlane;
        const baseUrl = `http://127.0.0.1:${handle.port}`;
        const authHeaders = { authorization: `Bearer ${BEARER_TOKEN}` };

        const runId = await createQuestionRun(baseUrl, authHeaders, projectId);

        // Tick must NOT crash despite the SDK failing.
        await captured.tick({
          principal: hardcodedDevelopmentPrincipal,
          tenant: hardcodedDevelopmentPrincipal.tenantId,
          runId
        });

        // The run must be terminal (failed cleanly).
        const runResp = await fetch(`${baseUrl}/v1/runs/${runId}`, { headers: authHeaders });
        expect(runResp.status).toBe(200);
        const runBody = (await runResp.json()) as { id: string; terminal: boolean };
        expect(runBody.terminal).toBe(true);

        // The credential must not appear in captured logs.
        const offendingLogs = logCapture.entries.filter((entry) =>
          entry.text.includes(CREDENTIAL_VALUE)
        );
        expect(offendingLogs).toEqual([]);
      } finally {
        logCapture.restore();
        await handle.close();
      }
    });
  });

  // Req 15: provider protocol failure terminates the run without leaking native payloads.
  it('terminates the run when the SDK launch throws a protocol failure error', { timeout: 60000 }, async () => {
    await withTempDatabasePath(async (databasePath) => {
      const { projectId } = await seedQuestionProject(databasePath);
      const harness = createFakeLaunchHarness();

      const bootstrap = await createControlPlaneServer({ autoDispatch: { enabled: false },
        databasePath,
        bearerToken: BEARER_TOKEN,
        masterSecret: MASTER_SECRET
      });
      let profileId: string;
      try {
        const inj = await bootstrap.inject({
          method: 'POST',
          url: '/v1/secrets',
          headers: { authorization: `Bearer ${BEARER_TOKEN}` },
          payload: { value: CREDENTIAL_VALUE }
        });
        expect(inj.statusCode).toBe(201);
        const { handle: secretHandle } = createSecretResponseSchema.parse(inj.json());

        const cfgInj = await bootstrap.inject({
          method: 'POST',
          url: '/v1/configuration-records',
          headers: { authorization: `Bearer ${BEARER_TOKEN}` },
          payload: {
            kind: 'provider_profile',
            providerKind: claudeProviderKind,
            adapterId: claudeAgentAdapterId,
            settings: {
              profileName: 'protocol-failure',
              credentialSecretHandle: secretHandle,
              endpoint: {
                baseUrl: ENDPOINT_BASE_URL,
                authEnvironmentVariable: 'ANTHROPIC_AUTH_TOKEN'
              }
            }
          }
        });
        expect(cfgInj.statusCode).toBe(201);
        profileId = configurationRecordResponseSchema.parse(cfgInj.json()).id;
      } finally {
        await bootstrap.close();
      }

      let controlPlane: ControlPlaneService | undefined;
      const handle = await startControlPlaneServer({ autoDispatch: { enabled: false },
        port: 0,
        databasePath,
        bearerToken: BEARER_TOKEN,
        masterSecret: MASTER_SECRET,
        runConcurrency: 1,
        realRunnerDispatch: { enabled: true, defaultProviderProfileId: profileId },
        providerAdapters: new Map([
          [
            buildProviderAdapterKey(claudeProviderKind, claudeAgentAdapterId),
            () =>
              createClaudeAgentAdapter({
                launchClaudeSession: harness.createProtocolFailureLaunch()
              })
          ]
        ]),
        onControlPlaneReady: (service) => { controlPlane = service; }
      });

      try {
        if (controlPlane === undefined) throw new Error('control-plane service not exposed');
        const captured = controlPlane;
        const baseUrl = `http://127.0.0.1:${handle.port}`;
        const authHeaders = { authorization: `Bearer ${BEARER_TOKEN}` };

        const runId = await createQuestionRun(baseUrl, authHeaders, projectId);

        // Tick must NOT crash despite the protocol error.
        await captured.tick({
          principal: hardcodedDevelopmentPrincipal,
          tenant: hardcodedDevelopmentPrincipal.tenantId,
          runId
        });

        // The run must be terminal (failed cleanly).
        const runResp = await fetch(`${baseUrl}/v1/runs/${runId}`, { headers: authHeaders });
        expect(runResp.status).toBe(200);
        const runBody = (await runResp.json()) as { id: string; terminal: boolean };
        expect(runBody.terminal).toBe(true);

        // No native SDK event payloads should appear in the stored run result.
        // The run steps response must not contain raw SDK event content.
        const stepsResp = await fetch(`${baseUrl}/v1/runs/${runId}/steps`, { headers: authHeaders });
        expect(stepsResp.status).toBe(200);
        const stepsBody = await stepsResp.text();
        expect(stepsBody).not.toContain('Unexpected session event sequence');
      } finally {
        await handle.close();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Run list — newest-first ordering and cross-tenant isolation
// ---------------------------------------------------------------------------

describe('run list integration', () => {
  it('lists authenticated tenant runs newest-first and excludes other tenant runs', async () => {
    await withTempDatabasePath(async (databasePath) => {
      // Seed database before starting server
      const seedDb = createSqliteDatabase({ path: databasePath });
      await migrateSqliteDatabase(seedDb);
      const seedRepos = createDrizzleDomainRepositories(seedDb);

      // Create a project for the main tenant (hardcodedDevelopmentPrincipal)
      const project = await seedRepos.projects.create({
        owner: hardcodedDevelopmentPrincipal,
        tenant: hardcodedDevelopmentPrincipal.tenantId,
        displayName: 'Run List Project',
        repoUrl: 'https://example.test/run-list',
        hostRepository: { provider: 'github', owner: 'test', name: 'run-list' },
        workspaceRootOverride: null,
        issueTrackerSetting: null,
        codeHostSetting: null,
        credentialRefs: []
      });

      // Create a run for another tenant directly in persistence (to prove isolation)
      const tenantTwoOwner = { kind: 'human' as const, id: 'user_other', tenantId: 'tenant_other' };
      const tenantTwoProject = await seedRepos.projects.create({
        owner: tenantTwoOwner,
        tenant: 'tenant_other',
        displayName: 'Other Tenant Project',
        repoUrl: 'https://example.test/other',
        hostRepository: { provider: 'github', owner: 'example', name: 'other' },
        workspaceRootOverride: null,
        issueTrackerSetting: null,
        codeHostSetting: null,
        credentialRefs: []
      });
      const tenantTwoConversation = await seedRepos.conversations.create({
        projectId: tenantTwoProject.id,
        owner: tenantTwoOwner,
        tenant: 'tenant_other',
        identity: 'other-tenant',
        activeTopicId: null
      });
      const tenantTwoTopic = await seedRepos.topics.create({
        conversationId: tenantTwoConversation.id,
        owner: tenantTwoOwner,
        tenant: 'tenant_other',
        title: 'Other tenant topic',
        kind: 'main'
      });
      const tenantTwoRun = await seedRepos.runs.create({
        topicId: tenantTwoTopic.id,
        owner: tenantTwoOwner,
        tenant: 'tenant_other',
        workKind: 'feature',
        currentStep: 'spec.author',
        terminal: false
      });
      seedDb.close();

      // Start the server
      const handle = await startControlPlaneServer({ autoDispatch: { enabled: false },
        port: 0,
        databasePath,
        bearerToken: BEARER_TOKEN,
        masterSecret: MASTER_SECRET
      });

      try {
        const baseUrl = `http://127.0.0.1:${handle.port}`;
        const headers = { authorization: `Bearer ${BEARER_TOKEN}` };

        // Create first run
        const first = await fetch(`${baseUrl}/v1/conversations`, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({
            projectId: project.id,
            identity: 'list-runs-first',
            topic: { title: 'First listable run' },
            submission: { kind: 'free_form', body: 'First body', workKind: 'feature' }
          })
        });
        expect(first.status).toBe(201);
        const firstBody = await first.json() as { run: { id: string } };

        // Small delay to ensure distinct createdAt timestamps
        await new Promise((resolve) => setTimeout(resolve, 5));

        // Create second run
        const second = await fetch(`${baseUrl}/v1/conversations`, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({
            projectId: project.id,
            identity: 'list-runs-second',
            topic: { title: 'Second listable run' },
            submission: { kind: 'free_form', body: 'Second body', workKind: 'bug' }
          })
        });
        expect(second.status).toBe(201);
        const secondBody = await second.json() as { run: { id: string } };

        // List runs
        const listed = await fetch(`${baseUrl}/v1/runs`, { method: 'GET', headers });
        expect(listed.status).toBe(200);
        const body = runListResponseSchema.parse(await listed.json());
        const ids = body.runs.map((run) => run.id);

        // Assert both runs present, newest first
        expect(body.runs.length).toBeGreaterThanOrEqual(2);
        expect(ids).toContain(firstBody.run.id);
        expect(ids).toContain(secondBody.run.id);
        expect(ids.indexOf(secondBody.run.id)).toBeLessThan(ids.indexOf(firstBody.run.id));

        // Assert cross-tenant isolation
        expect(ids).not.toContain(tenantTwoRun.id);
        expect(body.runs.every((run) => run.tenant === hardcodedDevelopmentPrincipal.tenantId)).toBe(true);
      } finally {
        await handle.close();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// OpenAI agent cell SSE event stream + checkpoint proof
// ---------------------------------------------------------------------------

describe('real OpenAI agent dispatch - SSE and checkpoint', () => {
  it('dispatches an OpenAI agent run through production SSE and records a RunStep', { timeout: 60000 }, async () => {
    await withTempDatabasePath(async (databasePath) => {
      const { projectId } = await seedQuestionProject(databasePath);

      // Bootstrap server to create profile config for OpenAI agent adapter.
      const bootstrap = await createControlPlaneServer({ autoDispatch: { enabled: false },
        databasePath,
        bearerToken: BEARER_TOKEN,
        masterSecret: MASTER_SECRET
      });
      let profileId: string;
      try {
        const cfgInj = await bootstrap.inject({
          method: 'POST',
          url: '/v1/configuration-records',
          headers: { authorization: `Bearer ${BEARER_TOKEN}` },
          payload: {
            kind: 'provider_profile',
            providerKind: 'openai',
            adapterId: 'openai-agents-sdk',
            settings: {
              profileName: 'integration-openai-agent',
              model: { provider: 'openai', model: 'gpt-4.1' }
            }
          }
        });
        expect(cfgInj.statusCode).toBe(201);
        profileId = configurationRecordResponseSchema.parse(cfgInj.json()).id;
      } finally {
        await bootstrap.close();
      }

      // Fake OpenAI agent adapter that returns an advance terminal event.
      const fakeOpenAIAdapter = createOpenAIAgentAdapter();
      // Override startSession to return fake events directly (bypasses SDK native mapping)
      fakeOpenAIAdapter.startSession = async (input) => {
        const runId = input.telemetryContext.runId;
        const step = input.telemetryContext.step ?? 'intake';
        async function* events(): AsyncIterable<RunnerEvent> {
          yield {
            id: 'evt_sse_terminal',
            runId,
            step,
            importance: 'normal',
            createdAt: new Date().toISOString(),
            type: 'runner_terminal_result',
            result: { directive: 'advance' }
          } as RunnerEvent;
        }
        return {
          events: events(),
          metadata: Promise.resolve({ outcome: 'succeeded' as const, launchMechanism: 'fetch_transport' as const, degradedCapabilities: [], tokenUsage: { available: false } as const })
        };
      };

      let controlPlane: ControlPlaneService | undefined;
      const handle = await startControlPlaneServer({ autoDispatch: { enabled: false },
        port: 0,
        databasePath,
        bearerToken: BEARER_TOKEN,
        masterSecret: MASTER_SECRET,
        runConcurrency: 1,
        realRunnerDispatch: { enabled: true, defaultProviderProfileId: profileId },
        providerAdapters: new Map([
          [
            buildProviderAdapterKey('openai', 'openai-agents-sdk'),
            () => fakeOpenAIAdapter
          ]
        ]),
        onControlPlaneReady: (service) => { controlPlane = service; }
      });

      try {
        if (controlPlane === undefined) throw new Error('control-plane not exposed');
        const captured = controlPlane;
        const baseUrl = `http://127.0.0.1:${handle.port}`;
        const authHeaders = { authorization: `Bearer ${BEARER_TOKEN}` };

        const runId = await createQuestionRun(baseUrl, authHeaders, projectId);

        const sseController = new AbortController();
        const eventsResp = await fetch(`${baseUrl}/v1/runs/${runId}/events`, {
          headers: authHeaders,
          signal: sseController.signal
        });
        expect(eventsResp.status).toBe(200);

        const tickPromise = captured.tick({
          principal: hardcodedDevelopmentPrincipal,
          tenant: hardcodedDevelopmentPrincipal.tenantId,
          runId
        });

        const reader = eventsResp.body?.getReader();
        if (reader === undefined) throw new Error('SSE body had no reader');
        const decoder = new TextDecoder();
        let buffer = '';
        let sawTerminalOrStateTransition = false;
        const deadline = setTimeout(() => sseController.abort(), 15000);
        try {
          while (!sawTerminalOrStateTransition) {
            const result = await reader.read();
            if (result.done) break;
            buffer += decoder.decode(result.value, { stream: true });
            if (/event:\s*run_state_transition|event:\s*runner_terminal_result/u.test(buffer)) {
              sawTerminalOrStateTransition = true;
            }
          }
        } catch {
          // aborted via deadline
        } finally {
          clearTimeout(deadline);
          sseController.abort();
          await reader.cancel().catch(() => undefined);
        }
        await tickPromise;

        expect(sawTerminalOrStateTransition).toBe(true);

        // RunStep must be persisted.
        const stepsResp = await fetch(`${baseUrl}/v1/runs/${runId}/steps`, { headers: authHeaders });
        expect(stepsResp.status).toBe(200);
        const stepsBody = (await stepsResp.json()) as { steps: Array<{ runId: string; step: string; startedAt: string }> };
        expect(stepsBody.steps.length).toBeGreaterThanOrEqual(1);
        expect(stepsBody.steps[0].runId).toBe(runId);
      } finally {
        await handle.close();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Spec review API surface: waitingOn, GET spec, POST/GET feedback
// ---------------------------------------------------------------------------

const SPEC_MARKDOWN = `---
created: 2026-06-12
last_updated: 2026-06-12
status: implementing
issue: 41
specced_by: autocatalyst
---
# Enhancement: Spec Review API Surface

## Product requirements
Test spec content.
`;

async function seedSpecReviewScenario(
  databasePath: string,
  tempDir: string
): Promise<{ runId: string }> {
  await mkdir(join(tempDir, 'context-human', 'specs'), { recursive: true });
  await writeFile(join(tempDir, 'context-human', 'specs', 'enhancement-spec-review.md'), SPEC_MARKDOWN, 'utf-8');

  const seedDb = createSqliteDatabase({ path: databasePath });
  await migrateSqliteDatabase(seedDb);
  const seedRepos = createDrizzleDomainRepositories(seedDb);

  const project = await seedRepos.projects.create({
    owner: hardcodedDevelopmentPrincipal,
    tenant: hardcodedDevelopmentPrincipal.tenantId,
    displayName: 'Spec Review Project',
    repoUrl: 'https://example.test/spec-review',
    hostRepository: { provider: 'github', owner: 'test', name: 'spec-review' },
    workspaceRootOverride: null,
    issueTrackerSetting: null,
    codeHostSetting: null,
    credentialRefs: []
  });

  const conversation = await seedRepos.conversations.create({
    projectId: project.id,
    owner: hardcodedDevelopmentPrincipal,
    tenant: hardcodedDevelopmentPrincipal.tenantId,
    identity: 'spec-review-test',
    activeTopicId: null
  });

  const topic = await seedRepos.topics.create({
    conversationId: conversation.id,
    owner: hardcodedDevelopmentPrincipal,
    tenant: hardcodedDevelopmentPrincipal.tenantId,
    title: 'Spec review topic',
    kind: 'main'
  });

  const run = await seedRepos.runs.create({
    topicId: topic.id,
    owner: hardcodedDevelopmentPrincipal,
    tenant: hardcodedDevelopmentPrincipal.tenantId,
    workKind: 'enhancement',
    currentStep: 'spec.human_review',
    terminal: false
  });

  await seedRepos.artifacts.create({
    runId: run.id,
    owner: hardcodedDevelopmentPrincipal,
    tenant: hardcodedDevelopmentPrincipal.tenantId,
    kind: 'enhancement_spec',
    canonicalRecord: 'file',
    location: 'context-human/specs/enhancement-spec-review.md',
    cachedStatus: 'draft',
    publicationRefs: []
  });

  await seedRepos.runWorkspaceMetadata.upsert({
    runId: run.id,
    workspaceHandle: 'test-workspace',
    workspaceRepoRoot: tempDir,
    createdAt: new Date().toISOString()
  });

  seedDb.close();
  return { runId: run.id };
}

describe('spec review API surface integration', () => {
  it('GET /v1/runs/:id returns waitingOn derived from currentStep', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const tempDir = await mkdtemp(join(tmpdir(), 'spec-review-waton-'));
      try {
        const { runId } = await seedSpecReviewScenario(databasePath, tempDir);

        const app = await createControlPlaneServer({ autoDispatch: { enabled: false },
          databasePath,
          bearerToken: BEARER_TOKEN,
          masterSecret: MASTER_SECRET
        });
        try {
          const resp = await app.inject({
            method: 'GET',
            url: `/v1/runs/${runId}`,
            headers: { authorization: `Bearer ${BEARER_TOKEN}` }
          });
          expect(resp.statusCode).toBe(200);
          const run = runSchema.parse(resp.json());
          expect(run.id).toBe(runId);
          expect(run.currentStep).toBe('spec.human_review');
          expect(run.waitingOn).toBe('human');
        } finally {
          await app.close();
        }
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  it('GET /v1/runs returns waitingOn for each run in list', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const tempDir = await mkdtemp(join(tmpdir(), 'spec-review-list-'));
      try {
        await seedSpecReviewScenario(databasePath, tempDir);

        const app = await createControlPlaneServer({ autoDispatch: { enabled: false },
          databasePath,
          bearerToken: BEARER_TOKEN,
          masterSecret: MASTER_SECRET
        });
        try {
          const resp = await app.inject({
            method: 'GET',
            url: '/v1/runs',
            headers: { authorization: `Bearer ${BEARER_TOKEN}` }
          });
          expect(resp.statusCode).toBe(200);
          const body = runListResponseSchema.parse(resp.json());
          expect(body.runs.length).toBeGreaterThanOrEqual(1);
          const specRun = body.runs.find((r) => r.currentStep === 'spec.human_review');
          expect(specRun).toBeDefined();
          expect(specRun?.waitingOn).toBe('human');
        } finally {
          await app.close();
        }
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  it('GET /v1/runs/:id/spec returns artifact, markdown, and frontmatter', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const tempDir = await mkdtemp(join(tmpdir(), 'spec-review-spec-'));
      try {
        const { runId } = await seedSpecReviewScenario(databasePath, tempDir);

        const app = await createControlPlaneServer({ autoDispatch: { enabled: false },
          databasePath,
          bearerToken: BEARER_TOKEN,
          masterSecret: MASTER_SECRET
        });
        try {
          const resp = await app.inject({
            method: 'GET',
            url: `/v1/runs/${runId}/spec`,
            headers: { authorization: `Bearer ${BEARER_TOKEN}` }
          });
          expect(resp.statusCode).toBe(200);
          const body = runSpecResponseSchema.parse(resp.json());
          expect(body.artifact.kind).toBe('enhancement_spec');
          expect(body.artifact.location).toBe('context-human/specs/enhancement-spec-review.md');
          expect(body.markdown).toContain('# Enhancement: Spec Review API Surface');
          expect(body.frontmatter.specced_by).toBe('autocatalyst');
          expect(body.frontmatter.status).toBe('implementing');
          expect(body.frontmatter.issue).toBe(41);
        } finally {
          await app.close();
        }
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  it('GET /v1/runs/:id/spec returns 404 for run with no spec artifact', async () => {
    await withTempDatabasePath(async (databasePath) => {
      // Seed a run with NO artifact
      const seedDb = createSqliteDatabase({ path: databasePath });
      await migrateSqliteDatabase(seedDb);
      const seedRepos = createDrizzleDomainRepositories(seedDb);

      const project = await seedRepos.projects.create({
        owner: hardcodedDevelopmentPrincipal,
        tenant: hardcodedDevelopmentPrincipal.tenantId,
        displayName: 'No Artifact Project',
        repoUrl: 'https://example.test/no-artifact',
        hostRepository: { provider: 'github', owner: 'test', name: 'no-artifact' },
        workspaceRootOverride: null,
        issueTrackerSetting: null,
        codeHostSetting: null,
        credentialRefs: []
      });
      const conversation = await seedRepos.conversations.create({
        projectId: project.id,
        owner: hardcodedDevelopmentPrincipal,
        tenant: hardcodedDevelopmentPrincipal.tenantId,
        identity: 'no-artifact-test',
        activeTopicId: null
      });
      const topic = await seedRepos.topics.create({
        conversationId: conversation.id,
        owner: hardcodedDevelopmentPrincipal,
        tenant: hardcodedDevelopmentPrincipal.tenantId,
        title: 'No artifact topic',
        kind: 'main'
      });
      const run = await seedRepos.runs.create({
        topicId: topic.id,
        owner: hardcodedDevelopmentPrincipal,
        tenant: hardcodedDevelopmentPrincipal.tenantId,
        workKind: 'enhancement',
        currentStep: 'spec.human_review',
        terminal: false
      });
      seedDb.close();

      const app = await createControlPlaneServer({ autoDispatch: { enabled: false },
        databasePath,
        bearerToken: BEARER_TOKEN,
        masterSecret: MASTER_SECRET
      });
      try {
        const resp = await app.inject({
          method: 'GET',
          url: `/v1/runs/${run.id}/spec`,
          headers: { authorization: `Bearer ${BEARER_TOKEN}` }
        });
        expect(resp.statusCode).toBe(404);
        const body = errorResponseSchema.parse(resp.json());
        expect(body.error.code).toBe('not_found');
      } finally {
        await app.close();
      }
    });
  });

  it('GET /v1/runs/:id/spec returns 404 for cross-tenant run', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const tempDir = await mkdtemp(join(tmpdir(), 'spec-review-xten-'));
      try {
        await mkdir(join(tempDir, 'context-human', 'specs'), { recursive: true });
        await writeFile(join(tempDir, 'context-human', 'specs', 'enhancement-spec-review.md'), SPEC_MARKDOWN, 'utf-8');

        const tenantOtherOwner = { kind: 'human' as const, id: 'user_other', tenantId: 'tenant_other' };

        const seedDb = createSqliteDatabase({ path: databasePath });
        await migrateSqliteDatabase(seedDb);
        const seedRepos = createDrizzleDomainRepositories(seedDb);

        const project = await seedRepos.projects.create({
          owner: tenantOtherOwner,
          tenant: 'tenant_other',
          displayName: 'Other Tenant Project',
          repoUrl: 'https://example.test/other-tenant',
          hostRepository: { provider: 'github', owner: 'other', name: 'repo' },
          workspaceRootOverride: null,
          issueTrackerSetting: null,
          codeHostSetting: null,
          credentialRefs: []
        });
        const conversation = await seedRepos.conversations.create({
          projectId: project.id,
          owner: tenantOtherOwner,
          tenant: 'tenant_other',
          identity: 'cross-tenant-test',
          activeTopicId: null
        });
        const topic = await seedRepos.topics.create({
          conversationId: conversation.id,
          owner: tenantOtherOwner,
          tenant: 'tenant_other',
          title: 'Cross-tenant topic',
          kind: 'main'
        });
        const run = await seedRepos.runs.create({
          topicId: topic.id,
          owner: tenantOtherOwner,
          tenant: 'tenant_other',
          workKind: 'enhancement',
          currentStep: 'spec.human_review',
          terminal: false
        });
        await seedRepos.artifacts.create({
          runId: run.id,
          owner: tenantOtherOwner,
          tenant: 'tenant_other',
          kind: 'enhancement_spec',
          canonicalRecord: 'file',
          location: 'context-human/specs/enhancement-spec-review.md',
          cachedStatus: 'draft',
          publicationRefs: []
        });
        await seedRepos.runWorkspaceMetadata.upsert({
          runId: run.id,
          workspaceHandle: 'other-workspace',
          workspaceRepoRoot: tempDir,
          createdAt: new Date().toISOString()
        });
        seedDb.close();

        const app = await createControlPlaneServer({ autoDispatch: { enabled: false },
          databasePath,
          bearerToken: BEARER_TOKEN,
          masterSecret: MASTER_SECRET
        });
        try {
          // Authenticated as tenant_dev, requesting a tenant_other run → 404
          const resp = await app.inject({
            method: 'GET',
            url: `/v1/runs/${run.id}/spec`,
            headers: { authorization: `Bearer ${BEARER_TOKEN}` }
          });
          expect(resp.statusCode).toBe(404);
        } finally {
          await app.close();
        }
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  it('GET /v1/runs/:id/spec returns 500 for valid artifact with missing workspace metadata', async () => {
    await withTempDatabasePath(async (databasePath) => {
      // Seed run + artifact but NO runWorkspaceMetadata upsert
      const seedDb = createSqliteDatabase({ path: databasePath });
      await migrateSqliteDatabase(seedDb);
      const seedRepos = createDrizzleDomainRepositories(seedDb);

      const project = await seedRepos.projects.create({
        owner: hardcodedDevelopmentPrincipal,
        tenant: hardcodedDevelopmentPrincipal.tenantId,
        displayName: 'Missing Metadata Project',
        repoUrl: 'https://example.test/missing-meta',
        hostRepository: { provider: 'github', owner: 'test', name: 'missing-meta' },
        workspaceRootOverride: null,
        issueTrackerSetting: null,
        codeHostSetting: null,
        credentialRefs: []
      });
      const conversation = await seedRepos.conversations.create({
        projectId: project.id,
        owner: hardcodedDevelopmentPrincipal,
        tenant: hardcodedDevelopmentPrincipal.tenantId,
        identity: 'missing-meta-test',
        activeTopicId: null
      });
      const topic = await seedRepos.topics.create({
        conversationId: conversation.id,
        owner: hardcodedDevelopmentPrincipal,
        tenant: hardcodedDevelopmentPrincipal.tenantId,
        title: 'Missing metadata topic',
        kind: 'main'
      });
      const run = await seedRepos.runs.create({
        topicId: topic.id,
        owner: hardcodedDevelopmentPrincipal,
        tenant: hardcodedDevelopmentPrincipal.tenantId,
        workKind: 'enhancement',
        currentStep: 'spec.human_review',
        terminal: false
      });
      await seedRepos.artifacts.create({
        runId: run.id,
        owner: hardcodedDevelopmentPrincipal,
        tenant: hardcodedDevelopmentPrincipal.tenantId,
        kind: 'enhancement_spec',
        canonicalRecord: 'file',
        location: 'context-human/specs/enhancement-spec-review.md',
        cachedStatus: 'draft',
        publicationRefs: []
      });
      // No runWorkspaceMetadata upsert → resolveWorkspaceContext will fail
      seedDb.close();

      const app = await createControlPlaneServer({ autoDispatch: { enabled: false },
        databasePath,
        bearerToken: BEARER_TOKEN,
        masterSecret: MASTER_SECRET
      });
      try {
        const resp = await app.inject({
          method: 'GET',
          url: `/v1/runs/${run.id}/spec`,
          headers: { authorization: `Bearer ${BEARER_TOKEN}` }
        });
        expect(resp.statusCode).toBe(500);
      } finally {
        await app.close();
      }
    });
  });

  it('POST /v1/runs/:id/feedback creates an open feedback item', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const tempDir = await mkdtemp(join(tmpdir(), 'spec-review-fb-'));
      try {
        const { runId } = await seedSpecReviewScenario(databasePath, tempDir);

        const app = await createControlPlaneServer({ autoDispatch: { enabled: false },
          databasePath,
          bearerToken: BEARER_TOKEN,
          masterSecret: MASTER_SECRET
        });
        try {
          const resp = await app.inject({
            method: 'POST',
            url: `/v1/runs/${runId}/feedback`,
            headers: {
              authorization: `Bearer ${BEARER_TOKEN}`,
              'content-type': 'application/json'
            },
            payload: {
              target: 'artifact',
              title: 'Missing section on error handling',
              body: 'The spec does not address error handling for edge cases.'
            }
          });
          expect(resp.statusCode).toBe(201);
          const feedback = feedbackSchema.parse(resp.json());
          expect(feedback.runId).toBe(runId);
          expect(feedback.target).toBe('artifact');
          expect(feedback.title).toBe('Missing section on error handling');
          expect(feedback.status).toBe('open');
          expect(feedback.tenant).toBe(hardcodedDevelopmentPrincipal.tenantId);
        } finally {
          await app.close();
        }
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  it('GET /v1/runs/:id/feedback lists feedback for the run', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const tempDir = await mkdtemp(join(tmpdir(), 'spec-review-fblist-'));
      try {
        const { runId } = await seedSpecReviewScenario(databasePath, tempDir);

        const app = await createControlPlaneServer({ autoDispatch: { enabled: false },
          databasePath,
          bearerToken: BEARER_TOKEN,
          masterSecret: MASTER_SECRET
        });
        try {
          // Create two feedback items
          await app.inject({
            method: 'POST',
            url: `/v1/runs/${runId}/feedback`,
            headers: {
              authorization: `Bearer ${BEARER_TOKEN}`,
              'content-type': 'application/json'
            },
            payload: {
              target: 'artifact',
              title: 'First feedback',
              body: 'First feedback body.'
            }
          });
          await app.inject({
            method: 'POST',
            url: `/v1/runs/${runId}/feedback`,
            headers: {
              authorization: `Bearer ${BEARER_TOKEN}`,
              'content-type': 'application/json'
            },
            payload: {
              target: 'artifact',
              title: 'Second feedback',
              body: 'Second feedback body.'
            }
          });

          const resp = await app.inject({
            method: 'GET',
            url: `/v1/runs/${runId}/feedback`,
            headers: { authorization: `Bearer ${BEARER_TOKEN}` }
          });
          expect(resp.statusCode).toBe(200);
          const body = runFeedbackListResponseSchema.parse(resp.json());
          expect(body.feedback).toHaveLength(2);
          expect(body.feedback.every((f) => f.runId === runId)).toBe(true);
          const titles = body.feedback.map((f) => f.title);
          expect(titles).toContain('First feedback');
          expect(titles).toContain('Second feedback');
        } finally {
          await app.close();
        }
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  it('POST /v1/runs/:id/feedback returns 404 for cross-tenant run', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const tempDir = await mkdtemp(join(tmpdir(), 'spec-review-fbxten-'));
      try {
        await mkdir(join(tempDir, 'context-human', 'specs'), { recursive: true });
        await writeFile(join(tempDir, 'context-human', 'specs', 'enhancement-spec-review.md'), SPEC_MARKDOWN, 'utf-8');

        const tenantOtherOwner = { kind: 'human' as const, id: 'user_other', tenantId: 'tenant_other' };

        const seedDb = createSqliteDatabase({ path: databasePath });
        await migrateSqliteDatabase(seedDb);
        const seedRepos = createDrizzleDomainRepositories(seedDb);

        const project = await seedRepos.projects.create({
          owner: tenantOtherOwner,
          tenant: 'tenant_other',
          displayName: 'Other Tenant FB Project',
          repoUrl: 'https://example.test/other-fb',
          hostRepository: { provider: 'github', owner: 'other', name: 'fb-repo' },
          workspaceRootOverride: null,
          issueTrackerSetting: null,
          codeHostSetting: null,
          credentialRefs: []
        });
        const conversation = await seedRepos.conversations.create({
          projectId: project.id,
          owner: tenantOtherOwner,
          tenant: 'tenant_other',
          identity: 'cross-tenant-fb-test',
          activeTopicId: null
        });
        const topic = await seedRepos.topics.create({
          conversationId: conversation.id,
          owner: tenantOtherOwner,
          tenant: 'tenant_other',
          title: 'Cross-tenant feedback topic',
          kind: 'main'
        });
        const run = await seedRepos.runs.create({
          topicId: topic.id,
          owner: tenantOtherOwner,
          tenant: 'tenant_other',
          workKind: 'enhancement',
          currentStep: 'spec.human_review',
          terminal: false
        });
        seedDb.close();

        const app = await createControlPlaneServer({ autoDispatch: { enabled: false },
          databasePath,
          bearerToken: BEARER_TOKEN,
          masterSecret: MASTER_SECRET
        });
        try {
          const resp = await app.inject({
            method: 'POST',
            url: `/v1/runs/${run.id}/feedback`,
            headers: {
              authorization: `Bearer ${BEARER_TOKEN}`,
              'content-type': 'application/json'
            },
            payload: {
              target: 'artifact',
              title: 'Cross-tenant feedback',
              body: 'Should be 404.'
            }
          });
          expect(resp.statusCode).toBe(404);
        } finally {
          await app.close();
        }
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  it('GET /v1/runs/:id/feedback returns 404 for cross-tenant run', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const tenantOtherOwner = { kind: 'human' as const, id: 'user_other', tenantId: 'tenant_other' };

      const seedDb = createSqliteDatabase({ path: databasePath });
      await migrateSqliteDatabase(seedDb);
      const seedRepos = createDrizzleDomainRepositories(seedDb);

      const project = await seedRepos.projects.create({
        owner: tenantOtherOwner,
        tenant: 'tenant_other',
        displayName: 'Other Tenant GET FB Project',
        repoUrl: 'https://example.test/other-getfb',
        hostRepository: { provider: 'github', owner: 'other', name: 'getfb-repo' },
        workspaceRootOverride: null,
        issueTrackerSetting: null,
        codeHostSetting: null,
        credentialRefs: []
      });
      const conversation = await seedRepos.conversations.create({
        projectId: project.id,
        owner: tenantOtherOwner,
        tenant: 'tenant_other',
        identity: 'cross-tenant-getfb-test',
        activeTopicId: null
      });
      const topic = await seedRepos.topics.create({
        conversationId: conversation.id,
        owner: tenantOtherOwner,
        tenant: 'tenant_other',
        title: 'Cross-tenant GET feedback topic',
        kind: 'main'
      });
      const run = await seedRepos.runs.create({
        topicId: topic.id,
        owner: tenantOtherOwner,
        tenant: 'tenant_other',
        workKind: 'enhancement',
        currentStep: 'spec.human_review',
        terminal: false
      });
      seedDb.close();

      const app = await createControlPlaneServer({ autoDispatch: { enabled: false },
        databasePath,
        bearerToken: BEARER_TOKEN,
        masterSecret: MASTER_SECRET
      });
      try {
        const resp = await app.inject({
          method: 'GET',
          url: `/v1/runs/${run.id}/feedback`,
          headers: { authorization: `Bearer ${BEARER_TOKEN}` }
        });
        expect(resp.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });
  });

  it('POST /v1/runs/:id/feedback returns 400 for invalid target', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const tempDir = await mkdtemp(join(tmpdir(), 'spec-review-fbval-'));
      try {
        const { runId } = await seedSpecReviewScenario(databasePath, tempDir);

        const app = await createControlPlaneServer({ autoDispatch: { enabled: false },
          databasePath,
          bearerToken: BEARER_TOKEN,
          masterSecret: MASTER_SECRET
        });
        try {
          const resp = await app.inject({
            method: 'POST',
            url: `/v1/runs/${runId}/feedback`,
            headers: {
              authorization: `Bearer ${BEARER_TOKEN}`,
              'content-type': 'application/json'
            },
            payload: {
              target: 'invalid_target',
              title: 'Some feedback',
              body: 'Some body.'
            }
          });
          expect(resp.statusCode).toBe(400);
          const body = errorResponseSchema.parse(resp.json());
          expect(body.error.code).toBe('validation_error');
        } finally {
          await app.close();
        }
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  it('POST /v1/runs/:id/feedback returns 400 for empty title', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const tempDir = await mkdtemp(join(tmpdir(), 'spec-review-fbempty-'));
      try {
        const { runId } = await seedSpecReviewScenario(databasePath, tempDir);

        const app = await createControlPlaneServer({ autoDispatch: { enabled: false },
          databasePath,
          bearerToken: BEARER_TOKEN,
          masterSecret: MASTER_SECRET
        });
        try {
          const resp = await app.inject({
            method: 'POST',
            url: `/v1/runs/${runId}/feedback`,
            headers: {
              authorization: `Bearer ${BEARER_TOKEN}`,
              'content-type': 'application/json'
            },
            payload: {
              target: 'artifact',
              title: '',
              body: 'Valid body.'
            }
          });
          expect(resp.statusCode).toBe(400);
          const body = errorResponseSchema.parse(resp.json());
          expect(body.error.code).toBe('validation_error');
        } finally {
          await app.close();
        }
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Feature dispatch workspace context regression test
// ---------------------------------------------------------------------------

describe('real feature dispatch workspace context', () => {
  it('loads the run project and workspace settings for a feature run through production dispatch', { timeout: 60000 }, async () => {
    await withTempDatabasePath(async (databasePath) => {
      const tempRoot = await mkdtemp(join(tmpdir(), 'autocatalyst-feature-dispatch-'));
      const reposRoot = join(tempRoot, 'repos');
      const workspacesRoot = join(tempRoot, 'workspaces');
      await mkdir(reposRoot, { recursive: true });
      await mkdir(workspacesRoot, { recursive: true });

      try {
        const hostRepoPath = await createLocalGitRepository(tempRoot);
        const { projectId } = await seedFeatureProject({ databasePath, repoUrl: `file://${hostRepoPath}` });

        // Bootstrap server to create provider profile config.
        // credentialSecretHandle is required: createExplicitProfileResolver always
        // sets credentialReference.required = true, so createAgentConnection needs
        // a resolvable secret handle or it throws missing_credential before dispatch.
        const bootstrap = await createControlPlaneServer({ autoDispatch: { enabled: false },
          databasePath,
          bearerToken: BEARER_TOKEN,
          masterSecret: MASTER_SECRET
        });
        let profileId: string;
        try {
          const secretInj = await bootstrap.inject({
            method: 'POST',
            url: '/v1/secrets',
            headers: { authorization: `Bearer ${BEARER_TOKEN}` },
            payload: { value: 'fake-openai-api-key' }
          });
          expect(secretInj.statusCode).toBe(201);
          const { handle: credentialHandle } = createSecretResponseSchema.parse(secretInj.json());

          const cfgInj = await bootstrap.inject({
            method: 'POST',
            url: '/v1/configuration-records',
            headers: { authorization: `Bearer ${BEARER_TOKEN}` },
            payload: {
              kind: 'provider_profile',
              providerKind: 'openai',
              adapterId: 'openai-agents-sdk',
              settings: {
                profileName: 'integration-openai-feature',
                credentialSecretHandle: credentialHandle,
                model: { provider: 'openai', model: 'gpt-4.1' }
              }
            }
          });
          expect(cfgInj.statusCode).toBe(201);
          profileId = configurationRecordResponseSchema.parse(cfgInj.json()).id;
        } finally {
          await bootstrap.close();
        }

        const capturedWorkspaceFacts: Array<{
          workspaceShape: string;
          workspaceRootCount: number;
          projectId: string;
        }> = [];

        // Fake adapter that captures workspace materialization facts
        const fakeOpenAIAdapter = createOpenAIAgentAdapter();
        fakeOpenAIAdapter.startSession = async (input) => {
          const runId = input.telemetryContext.runId;
          const step = input.telemetryContext.step ?? 'spec.author';
          const workspace = input.runInput.environment.workspace;
          const workspaceIntent = input.runInput.environment.context.workspaceIntent;
          capturedWorkspaceFacts.push({
            workspaceShape: workspace.shape,
            workspaceRootCount: workspace.workspaceRoots.length,
            projectId: workspaceIntent.shape === 'two_roots' ? workspaceIntent.provisioning.project.id : 'none'
          });
          async function* events(): AsyncIterable<RunnerEvent> {
            yield {
              id: 'evt_feature_terminal',
              runId,
              step,
              importance: 'normal',
              createdAt: new Date().toISOString(),
              type: 'runner_terminal_result',
              result: { directive: 'advance' }
            } as RunnerEvent;
          }
          return {
            events: events(),
            metadata: Promise.resolve({
              outcome: 'succeeded' as const,
              launchMechanism: 'fetch_transport' as const,
              degradedCapabilities: [],
              tokenUsage: { available: false } as const
            })
          };
        };

        let controlPlane: ControlPlaneService | undefined;
        const handle = await startControlPlaneServer({ autoDispatch: { enabled: false },
          port: 0,
          databasePath,
          bearerToken: BEARER_TOKEN,
          masterSecret: MASTER_SECRET,
          runConcurrency: 1,
          workspaceRoots: { reposRoot, workspacesRoot },
          realRunnerDispatch: { enabled: true, defaultProviderProfileId: profileId },
          providerAdapters: new Map([
            [
              buildProviderAdapterKey('openai', 'openai-agents-sdk'),
              () => fakeOpenAIAdapter
            ]
          ]),
          onControlPlaneReady: (service) => { controlPlane = service; }
        });

        try {
          if (controlPlane === undefined) throw new Error('control-plane not exposed');
          const baseUrl = `http://127.0.0.1:${handle.port}`;
          const authHeaders = { authorization: `Bearer ${BEARER_TOKEN}` };
          const runId = await createFeatureRun(baseUrl, authHeaders, projectId);

          await controlPlane.tick({
            principal: hardcodedDevelopmentPrincipal,
            tenant: hardcodedDevelopmentPrincipal.tenantId,
            runId
          });

          // Assert workspace context captured at startSession call time.
          expect(capturedWorkspaceFacts).toEqual([
            { workspaceShape: 'two_roots', workspaceRootCount: 2, projectId }
          ]);

          // The run transitions to terminal after the tick (either advanced or failed
          // — the fake adapter does not write a result file so scratch_file validation
          // converts the advance directive to a fail, which is expected).
          const runResp = await fetch(`${baseUrl}/v1/runs/${runId}`, { headers: authHeaders });
          expect(runResp.status).toBe(200);
          const runBody = runSchema.parse(await runResp.json());
          expect(runBody.terminal).toBe(true);
        } finally {
          await handle.close();
        }
      } finally {
        await rm(tempRoot, { recursive: true, force: true });
      }
    });
  });
});
