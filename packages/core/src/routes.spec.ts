import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

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

import { registerControlPlaneRoutes } from './routes.js';
import type { ControlPlaneRouteDependencies } from './routes.js';

async function buildServer(overrides: Partial<ControlPlaneRouteDependencies> = {}) {
  const stored = new Map<string, ProbeResource>();
  const app = Fastify({ logger: false });
  const dependencies: ControlPlaneRouteDependencies = {
    health: { isDatabaseReachable: async () => true },
    probeResources: {
      create: async (input) => {
        const resource = {
          id: 'probe_test',
          value: input.value,
          createdAt: '2026-06-08T12:00:00.000Z'
        } satisfies ProbeResource;
        stored.set(resource.id, resource);
        return resource;
      },
      findById: async (id) => stored.get(id) ?? null
    },
    ...overrides
  };

  await registerControlPlaneRoutes(app, dependencies);
  return app;
}

describe('registerControlPlaneRoutes', () => {
  let server: Awaited<ReturnType<typeof buildServer>> | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('registers unversioned health and returns degraded status when database is unreachable', async () => {
    server = await buildServer({ health: { isDatabaseReachable: async () => false } });

    const healthy = await server.inject({ method: 'GET', url: '/v1/health' });
    expect(healthy.statusCode).toBe(404);

    const response = await server.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(degradedHealthStatusCode);
    expect(healthResponseSchema.parse(response.json())).toEqual({
      status: 'degraded',
      database: { status: 'unreachable' }
    });
  });

  it('creates and reads a probe resource with contract status and shapes', async () => {
    server = await buildServer();

    const created = await server.inject({
      method: 'POST',
      url: probeResourceCollectionPath,
      payload: { value: 'through route' }
    });

    expect(created.statusCode).toBe(createProbeResourceSuccessStatusCode);
    const createdBody = probeResourceSchema.parse(created.json());
    expect(createdBody.value).toBe('through route');

    const read = await server.inject({ method: 'GET', url: `${probeResourceCollectionPath}/${createdBody.id}` });
    expect(read.statusCode).toBe(200);
    expect(probeResourceSchema.parse(read.json())).toEqual(createdBody);
  });

  it('returns contract error envelopes for invalid requests and missing resources', async () => {
    server = await buildServer();

    const invalid = await server.inject({
      method: 'POST',
      url: probeResourceCollectionPath,
      payload: { value: '' }
    });
    expect(invalid.statusCode).toBe(400);
    expect(errorResponseSchema.parse(invalid.json()).error.code).toBe('validation_error');

    const missing = await server.inject({ method: 'GET', url: `${probeResourceCollectionPath}/missing` });
    expect(missing.statusCode).toBe(404);
    expect(errorResponseSchema.parse(missing.json()).error.code).toBe('not_found');
  });

  it('exposes an SSE route with event-stream semantics', async () => {
    server = await buildServer();
    await server.listen({ port: 0, host: '127.0.0.1' });
    const address = server.server.address();
    if (typeof address !== 'object' || address === null) {
      throw new Error('Expected server address to be an object.');
    }

    const controller = new AbortController();
    const response = await fetch(
      `http://127.0.0.1:${(address as { port: number }).port}${eventsStreamPath}`,
      { signal: controller.signal }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/event-stream/u);
    expect(response.headers.get('cache-control')).toContain('no-cache');

    controller.abort(); // Close the SSE connection cleanly
  });
});
