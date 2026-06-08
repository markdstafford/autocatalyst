import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createProbeResourceSuccessStatusCode,
  degradedHealthStatusCode,
  errorResponseSchema,
  eventsStreamPath,
  healthResponseSchema,
  probeResourceCollectionPath,
  probeResourceSchema,
  type ProbeResource
} from '@autocatalyst/api-contract';

import { hardcodedDevelopmentPrincipal } from './principal.js';
import { registerControlPlaneRoutes } from './routes.js';
import type { ControlPlaneRouteDependencies } from './routes.js';
import type { PolicyDecisionInput } from './policy.js';

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
      create: vi.fn(async () => ({ id: 'cfg_123', kind: 'provider_profile', providerKind: 'model_runner', adapterId: 'openai', settings: { profileName: 'default' }, createdAt: '2026-06-08T00:00:00.000Z', updatedAt: '2026-06-08T00:00:00.000Z' })),
      list: vi.fn(async () => []),
      findById: vi.fn(async () => null),
      update: vi.fn(async () => null),
      delete: vi.fn(async () => false)
    },
    secrets: {
      createSecret: vi.fn(async () => ({ handle: 'sec_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef' }))
    },
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
