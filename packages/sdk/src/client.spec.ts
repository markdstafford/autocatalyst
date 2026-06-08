import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createProbeResourceSuccessStatusCode,
  degradedHealthStatusCode,
  probeResourceCollectionPath,
  type ProbeResource
} from '@autocatalyst/api-contract';
import { registerControlPlaneRoutes } from '@autocatalyst/core';

import { ControlPlaneClientError, createControlPlaneClient } from './client.js';

describe('bearer token auth', () => {
  it('sends authorization header on protected calls when bearerToken is configured', async () => {
    const mockFetch = vi.fn(async (_url: string, _init?: RequestInit) => {
      return new Response(JSON.stringify({ id: 'probe_1', value: 'x', createdAt: '2026-01-01T00:00:00.000Z' }), {
        status: 201,
        headers: { 'content-type': 'application/json' }
      });
    });

    const client = createControlPlaneClient({ baseUrl: 'http://localhost:3000', fetch: mockFetch, bearerToken: 'sdk-token' });
    await client.createProbeResource({ value: 'x' });

    const [, init] = mockFetch.mock.calls[0];
    expect((init?.headers as Record<string, string>)?.authorization).toBe('Bearer sdk-token');
  });

  it('does not send authorization header on getHealth', async () => {
    const mockFetch = vi.fn(async () =>
      new Response(JSON.stringify({ status: 'ok', database: { status: 'reachable' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );

    const client = createControlPlaneClient({ baseUrl: 'http://localhost:3000', fetch: mockFetch, bearerToken: 'sdk-token' });
    await client.getHealth();

    const [, init] = mockFetch.mock.calls[0];
    expect((init?.headers as Record<string, string>)?.authorization).toBeUndefined();
  });
});

describe('configuration record methods', () => {
  it('creates, lists, gets, updates, and deletes configuration records', async () => {
    const record = {
      id: 'cfg_123', kind: 'provider_profile', providerKind: 'model_runner',
      adapterId: 'openai', settings: { profileName: 'default' },
      createdAt: '2026-06-08T00:00:00.000Z', updatedAt: '2026-06-08T00:00:00.000Z'
    };

    const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const urlStr = url.toString();

      if (method === 'POST' && urlStr.endsWith('/v1/configuration-records')) {
        return new Response(JSON.stringify(record), { status: 201, headers: { 'content-type': 'application/json' } });
      }
      if (method === 'GET' && urlStr.endsWith('/v1/configuration-records')) {
        return new Response(JSON.stringify({ records: [record] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (method === 'GET' && urlStr.includes('/v1/configuration-records/')) {
        return new Response(JSON.stringify(record), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (method === 'PATCH') {
        return new Response(JSON.stringify({ ...record, providerKind: 'updated' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected: ${method} ${urlStr}`);
    });

    const client = createControlPlaneClient({ baseUrl: 'http://localhost:3000', fetch: mockFetch, bearerToken: 'sdk-token' });

    const created = await client.createConfigurationRecord({ kind: 'provider_profile', providerKind: 'model_runner', adapterId: 'openai', settings: { profileName: 'default' } });
    expect(created.id).toBe('cfg_123');

    const listed = await client.listConfigurationRecords();
    expect(listed.records).toHaveLength(1);

    const fetched = await client.getConfigurationRecord('cfg_123');
    expect(fetched.id).toBe('cfg_123');

    const updated = await client.updateConfigurationRecord('cfg_123', { providerKind: 'updated' });
    expect(updated.providerKind).toBe('updated');

    const deleteResult = await client.deleteConfigurationRecord('cfg_123');
    expect(deleteResult).toBeUndefined();

    // Verify auth header on all calls
    for (const [, init] of mockFetch.mock.calls) {
      expect((init?.headers as Record<string, string>)?.authorization).toBe('Bearer sdk-token');
    }
  });

  it('throws ControlPlaneClientError for error responses', async () => {
    const mockFetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: { code: 'not_found', message: 'Not found.' } }), {
        status: 404, headers: { 'content-type': 'application/json' }
      })
    );
    const client = createControlPlaneClient({ baseUrl: 'http://localhost:3000', fetch: mockFetch, bearerToken: 'sdk-token' });
    await expect(client.getConfigurationRecord('cfg_missing')).rejects.toThrow(ControlPlaneClientError);
  });
});

describe('createSecret method', () => {
  it('creates a secret and returns only a handle', async () => {
    const mockFetch = vi.fn(async () =>
      new Response(JSON.stringify({ handle: 'sec_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef' }), {
        status: 201, headers: { 'content-type': 'application/json' }
      })
    );
    const client = createControlPlaneClient({ baseUrl: 'http://localhost:3000', fetch: mockFetch, bearerToken: 'sdk-token' });
    const result = await client.createSecret({ value: 'sk-test' });
    expect(result.handle).toBe('sec_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef');
    const [, init] = mockFetch.mock.calls[0];
    expect((init?.headers as Record<string, string>)?.authorization).toBe('Bearer sdk-token');
  });

  it('throws ControlPlaneClientError for locked store', async () => {
    const mockFetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: { code: 'secret_store_locked', message: 'Locked.' } }), {
        status: 400, headers: { 'content-type': 'application/json' }
      })
    );
    const client = createControlPlaneClient({ baseUrl: 'http://localhost:3000', fetch: mockFetch, bearerToken: 'sdk-token' });
    await expect(client.createSecret({ value: 'sk-test' })).rejects.toThrow(ControlPlaneClientError);
  });
});

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

  it('resolves with degraded health when the server returns 503 with a valid HealthResponse', async () => {
    const degradedBody = { status: 'degraded', database: { status: 'unreachable' } };
    const fetch = vi.fn(async () =>
      new Response(JSON.stringify(degradedBody), { status: degradedHealthStatusCode })
    );
    const client = createControlPlaneClient({ baseUrl: 'http://example.test', fetch });

    await expect(client.getHealth()).resolves.toEqual(degradedBody);
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

  const testBearerToken = 'sdk-server-test-token';

  function baseTestDeps() {
    return {
      auth: { bearerToken: testBearerToken },
      policy: { authorize: async () => ({ allowed: true as const }) },
      configurationRecords: {
        create: async () => { throw new Error('not used'); },
        list: async () => [],
        findById: async () => null,
        update: async () => null,
        delete: async () => false
      },
      secrets: { createSecret: async () => { throw new Error('not used'); } }
    };
  }

  it('returns degraded health when the health checker reports the database is unreachable', async () => {
    testApp = Fastify({ logger: false });
    await registerControlPlaneRoutes(testApp, {
      ...baseTestDeps(),
      health: { isDatabaseReachable: async () => false },
      probeResources: {
        create: async () => { throw new Error('not used'); },
        findById: async () => null
      }
    });
    await testApp.listen({ port: 0, host: '127.0.0.1' });
    const address = testApp.server.address();
    if (typeof address !== 'object' || address === null) {
      throw new Error('Expected Fastify to listen on a TCP port.');
    }

    const client = createControlPlaneClient({ baseUrl: `http://127.0.0.1:${address.port}` });

    await expect(client.getHealth()).resolves.toEqual({
      status: 'degraded',
      database: { status: 'unreachable' }
    });
  });

  it('calls health, create, read, and 404 paths over HTTP', async () => {
    const stored = new Map<string, ProbeResource>();
    testApp = Fastify({ logger: false });
    await registerControlPlaneRoutes(testApp, {
      ...baseTestDeps(),
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

    const client = createControlPlaneClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      bearerToken: testBearerToken
    });

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
