import { describe, expect, it, vi } from 'vitest';

import {
  createProbeResourceSuccessStatusCode,
  probeResourceCollectionPath
} from '@autocatalyst/api-contract';

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
