import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createProbeResourceSuccessStatusCode,
  degradedHealthStatusCode,
  probeResourceCollectionPath,
  runCollectionPath,
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
      adapterId: 'openai', settings: { profileName: 'default' }, tenant: 'test-tenant',
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

    const created = await client.createConfigurationRecord({ tenant: 'test-tenant', kind: 'provider_profile', providerKind: 'model_runner', adapterId: 'openai', settings: { profileName: 'default' } });
    expect(created.id).toBe('cfg_123');

    const listed = await client.listConfigurationRecords();
    expect(listed.records).toHaveLength(1);

    const fetched = await client.getConfigurationRecord('cfg_123');
    expect(fetched.id).toBe('cfg_123');

    const updated = await client.updateConfigurationRecord('cfg_123', { kind: 'provider_profile', providerKind: 'updated' });
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

describe('orchestrator ingress methods', () => {
  const owner = { kind: 'human' as const, id: 'user_1', tenantId: 'org_1' };
  const baseConversation = {
    id: 'conv_1', projectId: 'proj_1', owner, tenant: 'org_1', identity: 'user_1',
    activeTopicId: null,
    createdAt: '2026-06-08T00:00:00.000Z', updatedAt: '2026-06-08T00:00:00.000Z'
  };
  const baseRun = {
    id: 'run_1', topicId: 'topic_1', owner,
    tenant: 'org_1', workKind: 'feature', currentStep: 'start',
    terminal: false,
    createdAt: '2026-06-08T00:00:00.000Z', updatedAt: '2026-06-08T00:00:00.000Z'
  };
  const baseTopic = {
    id: 'topic_1', conversationId: 'conv_1', owner, tenant: 'org_1',
    title: 'Do work', kind: 'main' as const,
    createdAt: '2026-06-08T00:00:00.000Z', updatedAt: '2026-06-08T00:00:00.000Z'
  };
  const baseRunStep = {
    id: 'step_1', runId: 'run_1', phase: null, step: 'start', role: 'orchestrator' as const,
    startedAt: '2026-06-08T00:00:00.000Z', endedAt: null, durationMs: null,
    occurrence: { index: 0, attempt: 1 },
    checkpointResult: null
  };

  it('createConversationWithFirstRun sends POST to /v1/conversations with bearer token and returns validated response', async () => {
    const responseBody = { conversation: baseConversation, topic: baseTopic, run: baseRun, runStep: baseRunStep };
    const mockFetch = vi.fn(async () =>
      new Response(JSON.stringify(responseBody), { status: 201, headers: { 'content-type': 'application/json' } })
    );
    const client = createControlPlaneClient({ baseUrl: 'http://localhost:3000', fetch: mockFetch, bearerToken: 'sdk-token' });
    const result = await client.createConversationWithFirstRun({
      projectId: 'proj_1', identity: 'user_1',
      topic: { title: 'Do work' },
      submission: { kind: 'free_form', body: 'Build something', workKind: 'feature' }
    });
    expect(result.run.id).toBe('run_1');
    const [url, init] = mockFetch.mock.calls[0];
    expect(String(url)).toContain('/v1/conversations');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)?.authorization).toBe('Bearer sdk-token');
  });

  it('getRun sends GET to /v1/runs/:id with bearer token', async () => {
    const mockFetch = vi.fn(async () =>
      new Response(JSON.stringify(baseRun), { status: 200, headers: { 'content-type': 'application/json' } })
    );
    const client = createControlPlaneClient({ baseUrl: 'http://localhost:3000', fetch: mockFetch, bearerToken: 'sdk-token' });
    const result = await client.getRun('run_1');
    expect(result.id).toBe('run_1');
    const [url, init] = mockFetch.mock.calls[0];
    expect(String(url)).toContain('/v1/runs/run_1');
    expect(init?.method).toBe('GET');
    expect((init?.headers as Record<string, string>)?.authorization).toBe('Bearer sdk-token');
  });

  it('listRuns sends GET to /v1/runs with bearer token and parses the response', async () => {
    const mockFetch = vi.fn(async () =>
      new Response(JSON.stringify({ runs: [baseRun] }), { status: 200, headers: { 'content-type': 'application/json' } })
    );
    const client = createControlPlaneClient({ baseUrl: 'http://localhost:3000', fetch: mockFetch, bearerToken: 'sdk-token' });

    const result = await client.listRuns();

    expect(result).toEqual({ runs: [baseRun] });
    const [url, init] = mockFetch.mock.calls[0];
    expect(String(url)).toBe(`http://localhost:3000${runCollectionPath}`);
    expect(init?.method).toBe('GET');
    expect((init?.headers as Record<string, string>)?.authorization).toBe('Bearer sdk-token');
  });

  it('listRuns rejects invalid successful response bodies', async () => {
    const mockFetch = vi.fn(async () =>
      new Response(JSON.stringify({ runs: [{ ...baseRun, unknownField: 'extra' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
    const client = createControlPlaneClient({ baseUrl: 'http://localhost:3000', fetch: mockFetch, bearerToken: 'sdk-token' });

    await expect(client.listRuns()).rejects.toThrow();
  });

  it('listRuns throws ControlPlaneClientError on non-ok response', async () => {
    const mockFetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: { code: 'forbidden', message: 'Forbidden.' } }), {
        status: 403,
        headers: { 'content-type': 'application/json' }
      })
    );
    const client = createControlPlaneClient({ baseUrl: 'http://localhost:3000', fetch: mockFetch, bearerToken: 'sdk-token' });

    await expect(client.listRuns()).rejects.toBeInstanceOf(ControlPlaneClientError);
  });

  it('listRunSteps sends GET to /v1/runs/:id/steps with bearer token', async () => {
    const mockFetch = vi.fn(async () =>
      new Response(JSON.stringify({ steps: [baseRunStep] }), { status: 200, headers: { 'content-type': 'application/json' } })
    );
    const client = createControlPlaneClient({ baseUrl: 'http://localhost:3000', fetch: mockFetch, bearerToken: 'sdk-token' });
    const result = await client.listRunSteps('run_1');
    expect(result.steps).toHaveLength(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(String(url)).toContain('/v1/runs/run_1/steps');
    expect(init?.method).toBe('GET');
    expect((init?.headers as Record<string, string>)?.authorization).toBe('Bearer sdk-token');
  });

  it('subscribeRunEvents sends GET to /v1/runs/:id/events and forwards last-event-id header', async () => {
    const mockFetch = vi.fn(async () =>
      new Response('', { status: 200, headers: { 'content-type': 'text/event-stream' } })
    );
    const client = createControlPlaneClient({ baseUrl: 'http://localhost:3000', fetch: mockFetch, bearerToken: 'sdk-token' });
    const result = await client.subscribeRunEvents('run_1', { lastEventId: 'evt_42' });
    expect(result.kind).toBe('response');
    expect(result.response.ok).toBe(true);
    const [url, init] = mockFetch.mock.calls[0];
    expect(String(url)).toContain('/v1/runs/run_1/events');
    expect(init?.method).toBe('GET');
    expect((init?.headers as Record<string, string>)?.['last-event-id']).toBe('evt_42');
    expect((init?.headers as Record<string, string>)?.authorization).toBe('Bearer sdk-token');
  });

  it('subscribeRunEvents appends ?replay=retained to the URL when replay option is set', async () => {
    const mockFetch = vi.fn(async () =>
      new Response('', { status: 200, headers: { 'content-type': 'text/event-stream' } })
    );
    const client = createControlPlaneClient({ baseUrl: 'http://localhost:3000', fetch: mockFetch, bearerToken: 'sdk-token' });
    await client.subscribeRunEvents('run_1', { replay: 'retained' });
    const [url] = mockFetch.mock.calls[0];
    expect(String(url)).toContain('?replay=retained');
    expect(String(url)).toContain('/v1/runs/run_1/events');
  });

  it('subscribeRunEvents throws ControlPlaneClientError on non-ok response', async () => {
    const mockFetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: { code: 'not_found', message: 'Run not found.' } }), {
        status: 404, headers: { 'content-type': 'application/json' }
      })
    );
    const client = createControlPlaneClient({ baseUrl: 'http://localhost:3000', fetch: mockFetch, bearerToken: 'sdk-token' });
    await expect(client.subscribeRunEvents('run_missing')).rejects.toBeInstanceOf(ControlPlaneClientError);
  });

  it('createConversationWithFirstRun throws ControlPlaneClientError for error response', async () => {
    const mockFetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: { code: 'bad_request', message: 'Invalid.' } }), {
        status: 400, headers: { 'content-type': 'application/json' }
      })
    );
    const client = createControlPlaneClient({ baseUrl: 'http://localhost:3000', fetch: mockFetch, bearerToken: 'sdk-token' });
    await expect(client.createConversationWithFirstRun({
      projectId: 'proj_1', identity: 'user_1',
      topic: { title: 'Do work' },
      submission: { kind: 'free_form', body: 'Build something', workKind: 'feature' }
    })).rejects.toBeInstanceOf(ControlPlaneClientError);
  });
});

describe('ControlPlaneClient.getRunSpec', () => {
  it('calls GET /v1/runs/:id/spec with bearer header and parses response', async () => {
    const specResponse = {
      artifact: {
        id: 'art_1', runId: 'run_1',
        owner: { kind: 'human', id: 'user_1', tenantId: 'tenant_1', displayName: 'Phoebe' },
        tenant: 'tenant_1', kind: 'enhancement_spec', canonicalRecord: 'file',
        location: 'context-human/specs/enhancement-spec.md',
        cachedStatus: 'draft', publicationRefs: [],
        createdAt: '2026-06-12T00:00:00.000Z', updatedAt: '2026-06-12T00:00:00.000Z'
      },
      markdown: '---\ncreated: 2026-06-12\nlast_updated: 2026-06-12\nstatus: implementing\nspecced_by: autocatalyst\n---\n# Title\n',
      frontmatter: {
        created: '2026-06-12', last_updated: '2026-06-12',
        status: 'implementing', specced_by: 'autocatalyst'
      }
    };
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => specResponse
    });
    const client = createControlPlaneClient({
      baseUrl: 'http://localhost:3000',
      bearerToken: 'test-token',
      fetch: mockFetch
    });
    const result = await client.getRunSpec('run_1');
    expect(mockFetch).toHaveBeenCalledWith(
      expect.objectContaining({ href: expect.stringContaining('/v1/runs/run_1/spec') }),
      expect.objectContaining({ method: 'GET', headers: expect.objectContaining({ authorization: 'Bearer test-token' }) })
    );
    expect(result.artifact.id).toBe('art_1');
  });

  it('throws ControlPlaneClientError on error response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: { code: 'not_found', message: 'Spec not found.' } })
    });
    const client = createControlPlaneClient({
      baseUrl: 'http://localhost:3000',
      bearerToken: 'test-token',
      fetch: mockFetch
    });
    await expect(client.getRunSpec('run_1')).rejects.toBeInstanceOf(ControlPlaneClientError);
  });
});

describe('ControlPlaneClient.createRunFeedback', () => {
  const feedbackItem = {
    id: 'fb_1', runId: 'run_1',
    owner: { kind: 'human', id: 'user_1', tenantId: 'tenant_1', displayName: 'Phoebe' },
    tenant: 'tenant_1', target: 'artifact', status: 'open',
    title: 'Scope unclear', body: 'Please clarify.',
    thread: [{ id: 'th_1', author: { kind: 'human', id: 'user_1', tenantId: 'tenant_1', displayName: 'Phoebe' }, body: 'Please clarify.', createdAt: '2026-06-12T00:00:00.000Z' }],
    createdAt: '2026-06-12T00:00:00.000Z', updatedAt: '2026-06-12T00:00:00.000Z'
  };

  it('calls POST /v1/runs/:id/feedback and parses created feedback', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => feedbackItem
    });
    const client = createControlPlaneClient({
      baseUrl: 'http://localhost:3000',
      bearerToken: 'test-token',
      fetch: mockFetch
    });
    const result = await client.createRunFeedback('run_1', {
      target: 'artifact',
      title: 'Scope unclear',
      body: 'Please clarify.'
    });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.objectContaining({ href: expect.stringContaining('/v1/runs/run_1/feedback') }),
      expect.objectContaining({ method: 'POST' })
    );
    expect(result.id).toBe('fb_1');
    expect(result.status).toBe('open');
  });

  it('rejects non-artifact target before sending (pre-send validation)', async () => {
    const mockFetch = vi.fn();
    const client = createControlPlaneClient({
      baseUrl: 'http://localhost:3000',
      bearerToken: 'test-token',
      fetch: mockFetch
    });
    await expect(client.createRunFeedback('run_1', {
      target: 'implementation' as unknown as 'artifact',
      title: 'Title',
      body: 'Body'
    })).rejects.toThrow();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('throws ControlPlaneClientError on error response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: { code: 'not_found', message: 'Run not found.' } })
    });
    const client = createControlPlaneClient({
      baseUrl: 'http://localhost:3000',
      bearerToken: 'test-token',
      fetch: mockFetch
    });
    await expect(client.createRunFeedback('run_1', {
      target: 'artifact',
      title: 'Title',
      body: 'Body'
    })).rejects.toBeInstanceOf(ControlPlaneClientError);
  });
});

describe('ControlPlaneClient.listRunFeedback', () => {
  it('calls GET /v1/runs/:id/feedback and parses feedback list', async () => {
    const listResponse = { feedback: [] };
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => listResponse
    });
    const client = createControlPlaneClient({
      baseUrl: 'http://localhost:3000',
      bearerToken: 'test-token',
      fetch: mockFetch
    });
    const result = await client.listRunFeedback('run_1');
    expect(mockFetch).toHaveBeenCalledWith(
      expect.objectContaining({ href: expect.stringContaining('/v1/runs/run_1/feedback') }),
      expect.objectContaining({ method: 'GET' })
    );
    expect(result.feedback).toHaveLength(0);
  });

  it('throws ControlPlaneClientError on error response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: { code: 'not_found', message: 'Run not found.' } })
    });
    const client = createControlPlaneClient({
      baseUrl: 'http://localhost:3000',
      bearerToken: 'test-token',
      fetch: mockFetch
    });
    await expect(client.listRunFeedback('run_1')).rejects.toBeInstanceOf(ControlPlaneClientError);
  });
});

describe('ControlPlaneClient.appendRunFeedbackThreadReply', () => {
  const feedbackItem = {
    id: 'fb_1', runId: 'run_1',
    owner: { kind: 'human', id: 'user_1', tenantId: 'tenant_1', displayName: 'Phoebe' },
    tenant: 'tenant_1', target: 'artifact', status: 'open',
    title: 'Scope unclear', body: 'Please clarify.',
    thread: [
      { id: 'th_1', author: { kind: 'human', id: 'user_1', tenantId: 'tenant_1', displayName: 'Phoebe' }, body: 'Please clarify.', createdAt: '2026-06-12T00:00:00.000Z' },
      { id: 'th_2', author: { kind: 'human', id: 'user_1', tenantId: 'tenant_1', displayName: 'Phoebe' }, body: 'Reply', createdAt: '2026-06-14T00:00:00.000Z' }
    ],
    createdAt: '2026-06-12T00:00:00.000Z', updatedAt: '2026-06-14T00:00:00.000Z'
  };

  it('appendRunFeedbackThreadReply sends POST to the correct URL', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => feedbackItem
    });
    const client = createControlPlaneClient({
      baseUrl: 'http://localhost:3000',
      bearerToken: 'test-token',
      fetch: mockFetch
    });
    const result = await client.appendRunFeedbackThreadReply('run_1', 'fb_1', { body: 'Reply' });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.objectContaining({ href: expect.stringContaining('/v1/runs/run_1/feedback/fb_1/thread') }),
      expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ authorization: 'Bearer test-token' }) })
    );
    expect(result.thread).toHaveLength(2);
  });

  it('throws ControlPlaneClientError on error response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: { code: 'not_found', message: 'Feedback not found.' } })
    });
    const client = createControlPlaneClient({
      baseUrl: 'http://localhost:3000',
      bearerToken: 'test-token',
      fetch: mockFetch
    });
    await expect(client.appendRunFeedbackThreadReply('run_1', 'fb_missing', { body: 'Reply' })).rejects.toBeInstanceOf(ControlPlaneClientError);
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
