import { expect, it, vi } from 'vitest';
import { createControlPlaneClient, type ControlPlaneClient } from './client.js';

const run = {
  id: 'run_1', topicId: 'topic_1', tenant: 'tenant_1', workKind: 'feature', currentStep: 'canceled', terminal: true,
  owner: { id: 'user_1', kind: 'human', tenantId: 'tenant_1' },
  title: 'Updated title', status: 'canceled', waitingOn: 'none', projectId: 'project_1',
  archivedAt: '2026-11-27T12:00:00.000Z', createdAt: '2026-11-26T12:00:00.000Z', updatedAt: '2026-11-27T12:00:00.000Z'
};

it.each([
  { method: 'POST', suffix: '/cancel', body: {}, call: (c: ControlPlaneClient) => c.cancelRun(run.id) },
  { method: 'POST', suffix: '/archive', body: {}, call: (c: ControlPlaneClient) => c.archiveRun(run.id) },
  { method: 'POST', suffix: '/unarchive', body: {}, call: (c: ControlPlaneClient) => c.unarchiveRun(run.id) },
  { method: 'POST', suffix: '/set-step', body: { step: 'spec.author' }, call: (c: ControlPlaneClient) => c.setRunStep(run.id, { step: 'spec.author' }) },
  { method: 'PATCH', suffix: '', body: { title: 'Updated title' }, call: (c: ControlPlaneClient) => c.renameRun(run.id, { title: '  Updated title  ' }) }
])('sends $method /v1/runs/run_1$suffix and validates the response', async ({ method, suffix, body, call }) => {
  const fetch = vi.fn()
    .mockResolvedValueOnce(Response.json({ run }))
    .mockResolvedValueOnce(Response.json({ run: { ...run, terminal: 1 } }));
  const client = createControlPlaneClient({ baseUrl: 'https://api.test', bearerToken: 'token', fetch });
  await expect(call(client)).resolves.toEqual({ run });
  expect(String(fetch.mock.calls[0]?.[0])).toBe(`https://api.test/v1/runs/${run.id}${suffix}`);
  expect(fetch.mock.calls[0]?.[1]).toEqual({
    method, headers: { authorization: 'Bearer token', 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  await expect(call(client)).rejects.toThrow();
});

it('serializes archive mode alongside list filters', async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ runs: [] }));
  const client = createControlPlaneClient({ baseUrl: 'https://api.test', fetch });
  await client.listRuns({ archived: 'only', status: ['failed', 'canceled'], limit: 2 });
  const url = new URL(String(fetch.mock.calls[0]?.[0]));
  expect(Object.fromEntries(url.searchParams)).toEqual({ archived: 'only', status: 'failed,canceled', limit: '2' });
});
