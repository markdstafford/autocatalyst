import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createProbeResourceSuccessStatusCode,
  probeResourceCollectionPath,
  type ProbeResource
} from '@autocatalyst/api-contract';
import { registerControlPlaneRoutes } from '@autocatalyst/core';

import { ControlPlaneClientError, createControlPlaneClient } from './client.js';

describe('control-plane SDK client', () => {
  it('calls health and parses the contract response', async () => {
    const fetch = vi.fn(async () =>
      new Response(JSON.stringify({ status: 'ok', database: { status: 'reachable' } }), { status: 200 })
    );
    const client = createControlPlaneClient({ baseUrl: 'http://example.test', fetch });

    await expect(client.getHealth()).resolves.toEqual({
      status: 'ok',
      database: { status: 'reachable' }
    });
    expect(String(fetch.mock.calls[0]?.[0])).toBe('http://example.test/health');
  });

  it('creates and reads probe resources using contract paths and shapes', async () => {
    const resource = {
      id: 'probe_sdk',
      value: 'from sdk',
      createdAt: '2026-06-08T12:00:00.000Z'
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(resource), { status: createProbeResourceSuccessStatusCode })
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(resource), { status: 200 }));
    const client = createControlPlaneClient({ baseUrl: 'http://example.test/base/', fetch });

    await expect(client.createProbeResource({ value: 'from sdk' })).resolves.toEqual(resource);
    await expect(client.getProbeResource(resource.id)).resolves.toEqual(resource);
    expect(String(fetch.mock.calls[0]?.[0])).toBe(`http://example.test${probeResourceCollectionPath}`);
  });

  it('throws ControlPlaneClientError for non-2xx error envelopes', async () => {
    const error = { error: { code: 'not_found', message: 'Probe resource not found.' } };
    const fetch = vi.fn(async () => new Response(JSON.stringify(error), { status: 404 }));
    const client = createControlPlaneClient({ baseUrl: 'http://example.test', fetch });

    await expect(client.getProbeResource('missing')).rejects.toMatchObject({
      status: 404,
      response: error
    });
    await expect(client.getProbeResource('missing')).rejects.toBeInstanceOf(ControlPlaneClientError);
  });
});

describe('control-plane SDK client against a test server', () => {
  let testApp: ReturnType<typeof Fastify> | undefined;

  afterEach(async () => {
    await testApp?.close();
    testApp = undefined;
  });

  it('calls health, create, read, and 404 paths over HTTP', async () => {
    const stored = new Map<string, ProbeResource>();
    testApp = Fastify({ logger: false });
    await registerControlPlaneRoutes(testApp, {
      health: { isDatabaseReachable: async () => true },
      probeResources: {
        create: async (input) => {
          const resource = {
            id: 'probe_sdk_server',
            value: input.value,
            createdAt: '2026-06-08T12:00:00.000Z'
          } satisfies ProbeResource;
          stored.set(resource.id, resource);
          return resource;
        },
        findById: async (id) => stored.get(id) ?? null
      }
    });
    await testApp.listen({ port: 0, host: '127.0.0.1' });
    const address = testApp.server.address();
    if (typeof address !== 'object' || address === null) {
      throw new Error('Expected Fastify to listen on a TCP port.');
    }

    const client = createControlPlaneClient({ baseUrl: `http://127.0.0.1:${address.port}` });

    await expect(client.getHealth()).resolves.toEqual({
      status: 'ok',
      database: { status: 'reachable' }
    });
    const created = await client.createProbeResource({ value: 'server-backed' });
    expect(created.value).toBe('server-backed');
    await expect(client.getProbeResource(created.id)).resolves.toEqual(created);
    await expect(client.getProbeResource('missing')).rejects.toBeInstanceOf(ControlPlaneClientError);
  });
});
