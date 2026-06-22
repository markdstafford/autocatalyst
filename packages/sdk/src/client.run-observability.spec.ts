import { describe, expect, it, vi } from 'vitest';
import { ControlPlaneClientError, createControlPlaneClient } from './client.js';

const pullRequestResponse = { pullRequest: {
  id: 'pr_1', runId: 'run_1', owner: { kind: 'human', id: 'user_1', tenantId: 'tenant_1', displayName: 'Opal Operator' }, tenant: 'tenant_1',
  provider: 'github', number: 123, url: 'https://github.com/acme/widgets/pull/123', state: 'open', branch: 'enhancement/widgets-run_1',
  createdAt: '2026-06-22T00:02:00.000Z', updatedAt: '2026-06-22T00:02:00.000Z'
} };

const sessionResponse = { sessions: [{
  id: 'sess_1', runId: 'run_1', phase: 'implementation', step: 'implementation.build', role: 'implementer', round: 1,
  model: { provider: 'anthropic', model: 'claude-sonnet-4' }, inferenceSettings: {},
  startedAt: '2026-06-22T00:03:00.000Z', endedAt: '2026-06-22T00:04:00.000Z', durationMs: 60000,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, usageAvailable: false,
  assistantTurnCount: 0, toolCallCount: 0, outcome: 'succeeded',
  cost: { model: { provider: 'anthropic', model: 'claude-sonnet-4' }, usd: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
}] };

describe('ControlPlaneClient run observability methods', () => {
  it('gets a run pull request with bearer auth', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(pullRequestResponse), { status: 200 }));
    const client = createControlPlaneClient({ baseUrl: 'https://api.test', bearerToken: 'token_1', fetch });
    await expect(client.getRunPullRequest('run_1')).resolves.toEqual(pullRequestResponse);
    expect(String(fetch.mock.calls[0]?.[0])).toBe('https://api.test/v1/runs/run_1/pull-request');
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'GET', headers: { authorization: 'Bearer token_1' } });
  });

  it('lists run sessions with bearer auth', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(sessionResponse), { status: 200 }));
    const client = createControlPlaneClient({ baseUrl: 'https://api.test', bearerToken: 'token_1', fetch });
    await expect(client.listRunSessions('run_1')).resolves.toEqual(sessionResponse);
    expect(String(fetch.mock.calls[0]?.[0])).toBe('https://api.test/v1/runs/run_1/sessions');
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'GET', headers: { authorization: 'Bearer token_1' } });
  });

  it('throws ControlPlaneClientError for non-2xx listRunSessions responses', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'not_found', message: 'Not found.' } }), { status: 404 }));
    const client = createControlPlaneClient({ baseUrl: 'https://api.test', fetch });
    await expect(client.listRunSessions('run_missing')).rejects.toBeInstanceOf(ControlPlaneClientError);
  });

  it('rejects listRunSessions responses with unknown top-level fields', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...sessionResponse, extra: true }), { status: 200 }));
    const client = createControlPlaneClient({ baseUrl: 'https://api.test', fetch });
    await expect(client.listRunSessions('run_1')).rejects.toThrow();
  });

  it('throws ControlPlaneClientError for non-2xx responses', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'not_found', message: 'Not found.' } }), { status: 404 }));
    const client = createControlPlaneClient({ baseUrl: 'https://api.test', fetch });
    await expect(client.getRunPullRequest('run_missing')).rejects.toBeInstanceOf(ControlPlaneClientError);
  });

  it('rejects successful responses with unknown top-level fields', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...pullRequestResponse, extra: true }), { status: 200 }));
    const client = createControlPlaneClient({ baseUrl: 'https://api.test', fetch });
    await expect(client.getRunPullRequest('run_1')).rejects.toThrow();
  });
});
