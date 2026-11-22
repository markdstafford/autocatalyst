import { describe, expect, it, vi } from 'vitest';

import { createControlPlaneClient } from './client.js';

const response = {
  issue: { number: 27, title: 'A tracked issue', url: 'https://example.test/issues/27', labels: ['feature'], state: 'open' },
  workKind: { kind: 'feature', source: 'label' }
};

describe('ControlPlaneClient.lookupProjectIssue', () => {
  it('URL-encodes the project ID as a single segment and makes an authenticated GET', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json(response));
    const client = createControlPlaneClient({ baseUrl: 'https://api.test', bearerToken: 'token', fetch });
    await expect(client.lookupProjectIssue('acme/a b?#%:number', 27)).resolves.toEqual(response);
    expect(String(fetch.mock.calls[0]?.[0])).toBe('https://api.test/v1/projects/acme%2Fa%20b%3F%23%25%3Anumber/issues/27');
    expect(fetch.mock.calls[0]?.[1]).toEqual({ method: 'GET', headers: { authorization: 'Bearer token' } });
  });

  it('validates the response and rejects issue bodies', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ ...response, issue: { ...response.issue, body: 'not a summary' } }));
    const client = createControlPlaneClient({ baseUrl: 'https://api.test', fetch });
    await expect(client.lookupProjectIssue('proj_1', 27)).rejects.toThrow();
  });

  it.each([
    [400, 'intake_routing_error', { code: 'tracker_auth_failed', trackerCode: 'tracker_auth_failed', provider: 'github' }],
    [404, 'not_found', { resource: 'issue' }]
  ])('preserves structured %i errors', async (status, code, details) => {
    const error = { code, message: 'Lookup failed.', details };
    const fetch = vi.fn().mockResolvedValue(Response.json({ error }, { status }));
    const client = createControlPlaneClient({ baseUrl: 'https://api.test', fetch });
    await expect(client.lookupProjectIssue('proj_1', 27)).rejects.toMatchObject({
      name: 'ControlPlaneClientError', status, response: { error }
    });
  });
});
