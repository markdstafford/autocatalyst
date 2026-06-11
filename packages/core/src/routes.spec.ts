import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  configurationRecordListResponseSchema,
  configurationRecordResponseSchema,
  createProbeResourceSuccessStatusCode,
  createSecretResponseSchema,
  degradedHealthStatusCode,
  errorResponseSchema,
  eventsStreamPath,
  healthResponseSchema,
  principalDiagnosticResponseSchema,
  probeResourceCollectionPath,
  probeResourceSchema,
  type ProbeResource
} from '@autocatalyst/api-contract';

import { SecretStoreLockedError } from './secret.js';

import { ControlPlaneServiceError, type ControlPlaneService } from './control-plane-service.js';
import { hardcodedDevelopmentPrincipal } from './principal.js';
import { registerControlPlaneRoutes } from './routes.js';
import type { ControlPlaneRouteDependencies } from './routes.js';
import type { PolicyDecisionInput } from './policy.js';
import type { RunEventSubscription } from './run-events.js';

function createFakeControlPlaneService(): ControlPlaneService {
  return {
    createConversationWithFirstRun: vi.fn(async () => {
      throw new Error('controlPlane.createConversationWithFirstRun not stubbed for this test');
    }),
    getRun: vi.fn(async () => {
      throw new Error('controlPlane.getRun not stubbed for this test');
    }),
    listRunSteps: vi.fn(async () => {
      throw new Error('controlPlane.listRunSteps not stubbed for this test');
    }),
    subscribeRunEvents: vi.fn(async () => {
      throw new Error('controlPlane.subscribeRunEvents not stubbed for this test');
    }),
    replayRunEvents: vi.fn(async (input) => ({
      status: 'ok' as const,
      events: [] as never[],
      ...(input.lastEventId !== undefined ? {} : {})
    })),
    tick: vi.fn(async () => ({ status: 'noop' as const }))
  };
}

async function buildServer(overrides?: Partial<ControlPlaneRouteDependencies>) {
  const bearerToken = 'test-token';
  const policyCalls: PolicyDecisionInput[] = [];
  const stored = new Map<string, ProbeResource>();

  const dependencies: ControlPlaneRouteDependencies = {
    health: { isDatabaseReachable: async () => true },
    auth: { bearerToken },
    policy: { authorize: async (input) => { policyCalls.push(input); return { allowed: true }; } },
    probeResources: {
      create: vi.fn(async (input) => {
        const resource: ProbeResource = { id: 'probe_123', value: input.value, createdAt: '2026-01-01T00:00:00.000Z' };
        stored.set(resource.id, resource);
        return resource;
      }),
      findById: vi.fn(async (id) => stored.get(id) ?? null)
    },
    configurationRecords: {
      create: vi.fn(async () => ({ id: 'cfg_123', tenant: 'tenant_dev', kind: 'provider_profile', providerKind: 'model_runner', adapterId: 'openai', settings: { profileName: 'default' }, createdAt: '2026-06-08T00:00:00.000Z', updatedAt: '2026-06-08T00:00:00.000Z' })),
      list: vi.fn(async () => []),
      findById: vi.fn(async () => null),
      update: vi.fn(async () => null),
      delete: vi.fn(async () => false)
    },
    secrets: {
      createSecret: vi.fn(async () => ({ handle: 'sec_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef' }))
    },
    controlPlane: createFakeControlPlaneService(),
    ...overrides
  };

  const app = Fastify({ logger: false });
  await registerControlPlaneRoutes(app, dependencies);
  return { app, authorization: { authorization: `Bearer ${bearerToken}` }, policyCalls };
}

describe('registerControlPlaneRoutes', () => {
  let server: Awaited<ReturnType<typeof buildServer>>['app'] | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('registers unversioned health and returns degraded status when database is unreachable', async () => {
    const { app } = await buildServer({ health: { isDatabaseReachable: async () => false } });
    server = app;

    const healthy = await app.inject({ method: 'GET', url: '/v1/health' });
    expect(healthy.statusCode).toBe(404);

    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(degradedHealthStatusCode);
    expect(healthResponseSchema.parse(response.json())).toEqual({
      status: 'degraded',
      database: { status: 'unreachable' }
    });
  });

  it('serves /health without auth', async () => {
    const { app } = await buildServer();
    server = app;
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
  });

  it('rejects protected v1 requests without a valid bearer token before handlers run', async () => {
    const { app } = await buildServer();
    server = app;

    // Missing token
    const missing = await app.inject({ method: 'POST', url: '/v1/probe-resources', payload: { value: 'x' } });
    expect(missing.statusCode).toBe(401);
    expect(errorResponseSchema.parse(missing.json()).error.code).toBe('unauthorized');

    // Wrong token
    const invalid = await app.inject({
      method: 'POST',
      url: '/v1/probe-resources',
      headers: { authorization: 'Bearer wrong-token' },
      payload: { value: 'x' }
    });
    expect(invalid.statusCode).toBe(401);
  });

  it('creates and reads a probe resource with contract status and shapes', async () => {
    const { app, authorization } = await buildServer();
    server = app;

    const created = await app.inject({
      method: 'POST',
      url: probeResourceCollectionPath,
      headers: authorization,
      payload: { value: 'through route' }
    });

    expect(created.statusCode).toBe(createProbeResourceSuccessStatusCode);
    const createdBody = probeResourceSchema.parse(created.json());
    expect(createdBody.value).toBe('through route');

    const read = await app.inject({
      method: 'GET',
      url: `${probeResourceCollectionPath}/${createdBody.id}`,
      headers: authorization
    });
    expect(read.statusCode).toBe(200);
    expect(probeResourceSchema.parse(read.json())).toEqual(createdBody);
  });

  it('consults policy for probe resource create', async () => {
    const { app, authorization, policyCalls } = await buildServer();
    server = app;

    await app.inject({
      method: 'POST',
      url: probeResourceCollectionPath,
      headers: authorization,
      payload: { value: 'policy test' }
    });

    expect(policyCalls).toContainEqual({
      principal: hardcodedDevelopmentPrincipal,
      action: 'probe_resource.create',
      resource: { kind: 'probe_resource_collection', path: '/v1/probe-resources' }
    });
  });

  it('returns contract error envelopes for invalid requests and missing resources', async () => {
    const { app, authorization } = await buildServer();
    server = app;

    const invalid = await app.inject({
      method: 'POST',
      url: probeResourceCollectionPath,
      headers: authorization,
      payload: { value: '' }
    });
    expect(invalid.statusCode).toBe(400);
    expect(errorResponseSchema.parse(invalid.json()).error.code).toBe('validation_error');

    const missing = await app.inject({
      method: 'GET',
      url: `${probeResourceCollectionPath}/missing`,
      headers: authorization
    });
    expect(missing.statusCode).toBe(404);
    expect(errorResponseSchema.parse(missing.json()).error.code).toBe('not_found');
  });

  it('exposes the protected hardcoded principal diagnostic route', async () => {
    const { app, authorization, policyCalls } = await buildServer();
    server = app;

    const response = await app.inject({ method: 'GET', url: '/v1/principal', headers: authorization });
    expect(response.statusCode).toBe(200);
    expect(principalDiagnosticResponseSchema.parse(response.json())).toEqual({
      principal: hardcodedDevelopmentPrincipal
    });
    expect(policyCalls).toContainEqual({
      principal: hardcodedDevelopmentPrincipal,
      action: 'principal.diagnostic.read',
      resource: { kind: 'principal_diagnostic', path: '' }
    });
  });

  it('creates, lists, reads, updates, and deletes configuration records', async () => {
    const record = {
      id: 'cfg_123',
      tenant: 'tenant_dev',
      kind: 'provider_profile',
      providerKind: 'model_runner',
      adapterId: 'openai',
      settings: { profileName: 'default' },
      createdAt: '2026-06-08T00:00:00.000Z',
      updatedAt: '2026-06-08T00:00:00.000Z'
    };
    const configRepo = {
      create: vi.fn(async () => record),
      list: vi.fn(async (_tenant: string) => [record]),
      findById: vi.fn(async (_tenant: string, id: string) => id === 'cfg_123' ? record : null),
      update: vi.fn(async (_tenant: string, id: string) => id === 'cfg_123' ? { ...record, updatedAt: '2026-06-08T01:00:00.000Z' } : null),
      delete: vi.fn(async (_tenant: string, id: string) => id === 'cfg_123')
    };
    const { app, authorization, policyCalls } = await buildServer({ configurationRecords: configRepo });
    server = app;

    // Create
    const createResponse = await app.inject({
      method: 'POST', url: '/v1/configuration-records', headers: authorization,
      payload: { kind: 'provider_profile', providerKind: 'model_runner', adapterId: 'openai', settings: { profileName: 'default' } }
    });
    expect(createResponse.statusCode).toBe(201);
    expect(configurationRecordResponseSchema.parse(createResponse.json())).toEqual(record);
    expect(policyCalls).toContainEqual({
      principal: hardcodedDevelopmentPrincipal,
      action: 'configuration_record.create',
      resource: { kind: 'configuration_record_collection', path: '/v1/configuration-records' }
    });

    // List
    const listResponse = await app.inject({ method: 'GET', url: '/v1/configuration-records', headers: authorization });
    expect(listResponse.statusCode).toBe(200);
    expect(configurationRecordListResponseSchema.parse(listResponse.json())).toEqual({ records: [record] });

    // Read
    const readResponse = await app.inject({ method: 'GET', url: '/v1/configuration-records/cfg_123', headers: authorization });
    expect(readResponse.statusCode).toBe(200);
    expect(configurationRecordResponseSchema.parse(readResponse.json())).toEqual(record);

    // Update
    const patchResponse = await app.inject({
      method: 'PATCH', url: '/v1/configuration-records/cfg_123', headers: authorization,
      payload: { kind: 'provider_profile', providerKind: 'updated_runner' }
    });
    expect(patchResponse.statusCode).toBe(200);

    // Delete
    const deleteResponse = await app.inject({ method: 'DELETE', url: '/v1/configuration-records/cfg_123', headers: authorization });
    expect(deleteResponse.statusCode).toBe(204);
    expect(deleteResponse.body).toBe('');
  });

  it('returns 404 for missing config records', async () => {
    const { app, authorization } = await buildServer();
    server = app;
    const response = await app.inject({ method: 'GET', url: '/v1/configuration-records/cfg_missing', headers: authorization });
    expect(response.statusCode).toBe(404);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('not_found');
  });

  it('returns 400 for invalid config create request', async () => {
    const { app, authorization } = await buildServer();
    server = app;
    const response = await app.inject({
      method: 'POST', url: '/v1/configuration-records', headers: authorization,
      payload: { kind: 'provider_profile', providerKind: 'x', adapterId: 'y', settings: { profileName: '' } }
    });
    expect(response.statusCode).toBe(400);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('validation_error');
  });

  it('returns 400 for empty patch body', async () => {
    const { app, authorization } = await buildServer();
    server = app;
    const response = await app.inject({
      method: 'PATCH', url: '/v1/configuration-records/cfg_123', headers: authorization,
      payload: {}
    });
    expect(response.statusCode).toBe(400);
  });

  it('returns 404 when deleting a missing config record', async () => {
    const { app, authorization } = await buildServer();
    server = app;
    const response = await app.inject({ method: 'DELETE', url: '/v1/configuration-records/cfg_missing', headers: authorization });
    expect(response.statusCode).toBe(404);
  });

  it('creates a secret handle via POST /v1/secrets', async () => {
    const { app, authorization, policyCalls } = await buildServer();
    server = app;
    const response = await app.inject({
      method: 'POST', url: '/v1/secrets', headers: authorization,
      payload: { value: 'sk-test-secret' }
    });
    expect(response.statusCode).toBe(201);
    expect(createSecretResponseSchema.parse(response.json())).toEqual({ handle: 'sec_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef' });
    expect(response.body).not.toContain('sk-test-secret');
    expect(policyCalls).toContainEqual({
      principal: hardcodedDevelopmentPrincipal,
      action: 'secret.create',
      resource: { kind: 'secret_collection', path: '/v1/secrets' }
    });
  });

  it('returns 400 for empty secret value', async () => {
    const { app, authorization } = await buildServer();
    server = app;
    const response = await app.inject({
      method: 'POST', url: '/v1/secrets', headers: authorization,
      payload: { value: '' }
    });
    expect(response.statusCode).toBe(400);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('validation_error');
  });

  it('maps SecretStoreLockedError to 400 secret_store_locked without echoing value', async () => {
    const lockedSecrets = { createSecret: vi.fn(async () => { throw new SecretStoreLockedError(); }) };
    const { app, authorization } = await buildServer({ secrets: lockedSecrets });
    server = app;
    const response = await app.inject({
      method: 'POST', url: '/v1/secrets', headers: authorization,
      payload: { value: 'my-secret-value' }
    });
    expect(response.statusCode).toBe(400);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('secret_store_locked');
    expect(response.body).not.toContain('my-secret-value');
  });

  it('POST /v1/conversations returns 201 with the orchestrated result on success', async () => {
    const orchestratedResult = {
      conversation: { id: 'conv_1', projectId: 'proj_1', owner: hardcodedDevelopmentPrincipal, tenant: 'tenant_dev', identity: 'I', activeTopicId: 'topic_1', createdAt: '2026-06-08T00:00:00.000Z', updatedAt: '2026-06-08T00:00:00.000Z' },
      topic: { id: 'topic_1', conversationId: 'conv_1', owner: hardcodedDevelopmentPrincipal, tenant: 'tenant_dev', title: 'My Topic', kind: 'main', createdAt: '2026-06-08T00:00:00.000Z', updatedAt: '2026-06-08T00:00:00.000Z' },
      message: { id: 'msg_1', topicId: 'topic_1', owner: hardcodedDevelopmentPrincipal, tenant: 'tenant_dev', author: hardcodedDevelopmentPrincipal, direction: 'inbound', body: 'hello', createdAt: '2026-06-08T00:00:00.000Z' },
      run: { id: 'run_1', topicId: 'topic_1', owner: hardcodedDevelopmentPrincipal, tenant: 'tenant_dev', workKind: 'feature', currentStep: 'intake', terminal: false, createdAt: '2026-06-08T00:00:00.000Z', updatedAt: '2026-06-08T00:00:00.000Z' },
      runStep: { id: 'step_1', runId: 'run_1', phase: 'intake', step: 'intake', role: 'none', startedAt: '2026-06-08T00:00:00.000Z', endedAt: null, durationMs: null, occurrence: { index: 0, attempt: 1 }, checkpointResult: null }
    };
    const controlPlane = createFakeControlPlaneService();
    (controlPlane.createConversationWithFirstRun as ReturnType<typeof vi.fn>).mockResolvedValue(orchestratedResult);
    const { app, authorization, policyCalls } = await buildServer({ controlPlane });
    server = app;

    const response = await app.inject({
      method: 'POST',
      url: '/v1/conversations',
      headers: authorization,
      payload: {
        projectId: 'proj_1',
        identity: 'I',
        topic: { title: 'My Topic' },
        submission: { kind: 'free_form', body: 'hello', workKind: 'feature' }
      }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual(orchestratedResult);
    expect(controlPlane.createConversationWithFirstRun).toHaveBeenCalledWith(expect.objectContaining({
      principal: hardcodedDevelopmentPrincipal,
      tenant: 'tenant_dev'
    }));
    expect(policyCalls).toContainEqual({
      principal: hardcodedDevelopmentPrincipal,
      action: 'conversation.create',
      resource: { kind: 'conversation_collection', path: '/v1/conversations' }
    });
  });

  it('POST /v1/conversations returns 400 for invalid bodies', async () => {
    const { app, authorization } = await buildServer();
    server = app;
    const response = await app.inject({
      method: 'POST',
      url: '/v1/conversations',
      headers: authorization,
      payload: { projectId: '' }
    });
    expect(response.statusCode).toBe(400);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('validation_error');
  });

  it('POST /v1/conversations maps intake_routing_error to 400 with details', async () => {
    const controlPlane = createFakeControlPlaneService();
    (controlPlane.createConversationWithFirstRun as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ControlPlaneServiceError('intake_routing_error', 'Unknown work kind.', { details: { workKind: 'bogus' } })
    );
    const { app, authorization } = await buildServer({ controlPlane });
    server = app;
    const response = await app.inject({
      method: 'POST',
      url: '/v1/conversations',
      headers: authorization,
      payload: {
        projectId: 'proj_1',
        identity: 'I',
        topic: { title: 'My Topic' },
        submission: { kind: 'free_form', body: 'hello', workKind: 'feature' }
      }
    });
    expect(response.statusCode).toBe(400);
    const parsed = errorResponseSchema.parse(response.json());
    expect(parsed.error.code).toBe('intake_routing_error');
  });

  it('POST /v1/conversations maps active_run_conflict to 409 with details', async () => {
    const controlPlane = createFakeControlPlaneService();
    (controlPlane.createConversationWithFirstRun as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ControlPlaneServiceError('active_run_conflict', 'Active run conflict.', {
        details: { topicId: 'topic_1', existingRunId: 'run_99' }
      })
    );
    const { app, authorization } = await buildServer({ controlPlane });
    server = app;
    const response = await app.inject({
      method: 'POST',
      url: '/v1/conversations',
      headers: authorization,
      payload: {
        projectId: 'proj_1',
        identity: 'I',
        topic: { title: 'My Topic' },
        submission: { kind: 'free_form', body: 'hello', workKind: 'feature' }
      }
    });
    expect(response.statusCode).toBe(409);
    const parsed = errorResponseSchema.parse(response.json());
    expect(parsed.error.code).toBe('active_run_conflict');
    expect(parsed.error.details).toEqual({ topicId: 'topic_1', existingRunId: 'run_99' });
  });

  it('GET /v1/runs/:id returns 200 with the run on success', async () => {
    const run = { id: 'run_1', topicId: 'topic_1', owner: hardcodedDevelopmentPrincipal, tenant: 'tenant_dev', workKind: 'feature', currentStep: 'intake', terminal: false, createdAt: '2026-06-08T00:00:00.000Z', updatedAt: '2026-06-08T00:00:00.000Z' };
    const controlPlane = createFakeControlPlaneService();
    (controlPlane.getRun as ReturnType<typeof vi.fn>).mockResolvedValue({ run });
    const { app, authorization, policyCalls } = await buildServer({ controlPlane });
    server = app;
    const response = await app.inject({ method: 'GET', url: '/v1/runs/run_1', headers: authorization });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(run);
    expect(controlPlane.getRun).toHaveBeenCalledWith({ principal: hardcodedDevelopmentPrincipal, tenant: 'tenant_dev', runId: 'run_1' });
    expect(policyCalls).toContainEqual({
      principal: hardcodedDevelopmentPrincipal,
      action: 'run.read',
      resource: { kind: 'run', id: 'run_1', path: '/v1/runs/:id' }
    });
  });

  it('GET /v1/runs/:id maps not_found to 404', async () => {
    const controlPlane = createFakeControlPlaneService();
    (controlPlane.getRun as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ControlPlaneServiceError('not_found', "Run 'missing' not found.")
    );
    const { app, authorization } = await buildServer({ controlPlane });
    server = app;
    const response = await app.inject({ method: 'GET', url: '/v1/runs/missing', headers: authorization });
    expect(response.statusCode).toBe(404);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('not_found');
  });

  it('GET /v1/runs/:id rejects unauthenticated requests with 401', async () => {
    const { app } = await buildServer();
    server = app;
    const response = await app.inject({ method: 'GET', url: '/v1/runs/run_1' });
    expect(response.statusCode).toBe(401);
  });

  it('GET /v1/runs/:id/steps returns 200 with the run-step list', async () => {
    const steps = [
      { id: 'step_1', runId: 'run_1', phase: 'intake', step: 'intake', role: 'none', startedAt: '2026-06-08T00:00:00.000Z', endedAt: null, durationMs: null, occurrence: { index: 0, attempt: 1 }, checkpointResult: null }
    ];
    const controlPlane = createFakeControlPlaneService();
    (controlPlane.listRunSteps as ReturnType<typeof vi.fn>).mockResolvedValue({ steps });
    const { app, authorization } = await buildServer({ controlPlane });
    server = app;
    const response = await app.inject({ method: 'GET', url: '/v1/runs/run_1/steps', headers: authorization });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ steps });
  });

  it('GET /v1/runs/:id/steps maps not_found to 404', async () => {
    const controlPlane = createFakeControlPlaneService();
    (controlPlane.listRunSteps as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ControlPlaneServiceError('not_found', "Run 'missing' not found.")
    );
    const { app, authorization } = await buildServer({ controlPlane });
    server = app;
    const response = await app.inject({ method: 'GET', url: '/v1/runs/missing/steps', headers: authorization });
    expect(response.statusCode).toBe(404);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('not_found');
  });

  it('GET /v1/runs/:id/events maps subscribeRunEvents not_found to 404 before writing SSE headers', async () => {
    const controlPlane = createFakeControlPlaneService();
    (controlPlane.subscribeRunEvents as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ControlPlaneServiceError('not_found', "Run 'missing' not found.")
    );
    const { app, authorization } = await buildServer({ controlPlane });
    server = app;
    const response = await app.inject({ method: 'GET', url: '/v1/runs/missing/events', headers: authorization });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).not.toMatch(/event-stream/u);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('not_found');
  });

  it('GET /v1/runs/:id/events forwards last-event-id header to subscribeRunEvents', async () => {
    const events: AsyncIterable<never> = { async *[Symbol.asyncIterator]() { /* no events */ } };
    const subscription: RunEventSubscription = { events, close: () => {} };
    const controlPlane = createFakeControlPlaneService();
    (controlPlane.subscribeRunEvents as ReturnType<typeof vi.fn>).mockResolvedValue(subscription);
    const { app, authorization } = await buildServer({ controlPlane });
    server = app;
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (typeof address !== 'object' || address === null) {
      throw new Error('Expected server address to be an object.');
    }

    const controller = new AbortController();
    const response = await fetch(
      `http://127.0.0.1:${(address as { port: number }).port}/v1/runs/run_1/events`,
      { signal: controller.signal, headers: { ...authorization, 'last-event-id': 'evt_42' } }
    );
    // Read the body so the server's async iterator can detect end-of-stream
    await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/event-stream/u);
    expect(controlPlane.subscribeRunEvents).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run_1', tenant: 'tenant_dev' })
    );
    expect(controlPlane.replayRunEvents).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run_1', tenant: 'tenant_dev', lastEventId: 'evt_42' })
    );
    controller.abort();
  });

  it('GET /v1/runs/:id/events writes event/id/data SSE frames for each published event', async () => {
    const timestamp = '2026-06-08T00:00:00.000Z';
    const run = { id: 'run_1', topicId: 'topic_1', owner: hardcodedDevelopmentPrincipal, tenant: 'tenant_dev', workKind: 'feature', currentStep: 'intake', terminal: false, createdAt: timestamp, updatedAt: timestamp };
    const runStep = { id: 'step_1', runId: 'run_1', phase: 'intake', step: 'intake', role: 'none', startedAt: timestamp, endedAt: null, durationMs: null, occurrence: { index: 0, attempt: 1 }, checkpointResult: null };
    const sseEvent = {
      id: 'evt_abc',
      type: 'run_state_transition' as const,
      runId: 'run_1',
      transition: { directive: 'start' as const, toStep: 'intake' },
      run,
      runStep,
      tenant: 'tenant_dev',
      createdAt: timestamp
    };

    async function* generateEvents() { yield sseEvent; }
    const closeSpy = vi.fn();
    const subscription: RunEventSubscription = { events: { [Symbol.asyncIterator]: generateEvents }, close: closeSpy };
    const controlPlane = createFakeControlPlaneService();
    (controlPlane.subscribeRunEvents as ReturnType<typeof vi.fn>).mockResolvedValue(subscription);

    const { app, authorization } = await buildServer({ controlPlane });
    server = app;
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address() as { port: number };

    const response = await fetch(`http://127.0.0.1:${address.port}/v1/runs/run_1/events`, {
      headers: authorization
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/event-stream/u);

    const body = await response.text();
    expect(body).toContain('event: run_state_transition\n');
    expect(body).toContain('id: evt_abc\n');
    expect(body).toContain(`data: ${JSON.stringify(sseEvent)}\n\n`);
  });

  it('GET /v1/runs/:id/events delivers live events when replay returns only pre-existing events', async () => {
    // Regression for dedup bug: if replay returns events that existed before subscribe(),
    // those ids will never appear in the live buffer. The route must still deliver live
    // events whose ids are not in the replay set.
    const timestamp = '2026-06-08T00:00:00.000Z';
    const run = { id: 'run_1', topicId: 'topic_1', owner: hardcodedDevelopmentPrincipal, tenant: 'tenant_dev', workKind: 'feature', currentStep: 'intake', terminal: false, createdAt: timestamp, updatedAt: timestamp };
    const runStep = { id: 'step_1', runId: 'run_1', phase: 'intake', step: 'intake', role: 'none', startedAt: timestamp, endedAt: null, durationMs: null, occurrence: { index: 0, attempt: 1 }, checkpointResult: null };

    const replayEvent = {
      id: 'evt_replay_1',
      type: 'run_state_transition' as const,
      runId: 'run_1',
      transition: { directive: 'start' as const, toStep: 'intake' },
      run, runStep, tenant: 'tenant_dev', createdAt: timestamp
    };
    const liveEvent = {
      id: 'evt_live_1',
      type: 'run_state_transition' as const,
      runId: 'run_1',
      transition: { directive: 'start' as const, toStep: 'intake' },
      run, runStep, tenant: 'tenant_dev', createdAt: timestamp
    };

    async function* generateLive() { yield liveEvent; }
    const subscription: RunEventSubscription = {
      events: { [Symbol.asyncIterator]: generateLive },
      close: vi.fn()
    };
    const controlPlane = createFakeControlPlaneService();
    (controlPlane.subscribeRunEvents as ReturnType<typeof vi.fn>).mockResolvedValue(subscription);
    (controlPlane.replayRunEvents as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 'ok' as const, events: [replayEvent]
    });

    const { app, authorization } = await buildServer({ controlPlane });
    server = app;
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address() as { port: number };

    const response = await fetch(`http://127.0.0.1:${address.port}/v1/runs/run_1/events`, {
      headers: { ...authorization, 'last-event-id': 'evt_prior' }
    });
    expect(response.status).toBe(200);
    const body = await response.text();

    // Both the replayed event and the subsequent live event must be present.
    expect(body).toContain('id: evt_replay_1\n');
    expect(body).toContain('id: evt_live_1\n');
  });

  it('GET /v1/runs/:id/events calls subscription.close() when server closes after stream ends', async () => {
    // Verify subscription.close() is called when the event stream completes naturally.
    // (The close() call in the finally block guarantees this.)
    let closeCalled = false;
    const events: AsyncIterable<never> = { async *[Symbol.asyncIterator]() { /* yields nothing */ } };
    const closeSpy = vi.fn(() => { closeCalled = true; });
    const subscription: RunEventSubscription = { events, close: closeSpy };
    const controlPlane = createFakeControlPlaneService();
    (controlPlane.subscribeRunEvents as ReturnType<typeof vi.fn>).mockResolvedValue(subscription);

    const { app, authorization } = await buildServer({ controlPlane });
    server = app;
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address() as { port: number };

    const response = await fetch(`http://127.0.0.1:${address.port}/v1/runs/run_1/events`, {
      headers: authorization
    });
    expect(response.status).toBe(200);

    // Read body to completion — when the generator ends naturally, finally calls close()
    await response.text();

    expect(closeSpy).toHaveBeenCalled();
    expect(closeCalled).toBe(true);
  });

  it('exposes an SSE route with event-stream semantics', async () => {
    const { app, authorization } = await buildServer();
    server = app;
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (typeof address !== 'object' || address === null) {
      throw new Error('Expected server address to be an object.');
    }

    const controller = new AbortController();
    const response = await fetch(
      `http://127.0.0.1:${(address as { port: number }).port}${eventsStreamPath}`,
      {
        signal: controller.signal,
        headers: authorization
      }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/event-stream/u);
    expect(response.headers.get('cache-control')).toContain('no-cache');

    controller.abort(); // Close the SSE connection cleanly
  });
});
