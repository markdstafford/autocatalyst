import { describe, expect, it } from 'vitest';

import {
  generateOpenApiDocument,
  getRunPullRequestSuccessStatusCode,
  listRunSessionsSuccessStatusCode,
  runPullRequestPath,
  runPullRequestResponseSchema,
  runSessionListResponseSchema,
  runSessionsPath
} from './index.js';

const owner = {
  kind: 'human' as const,
  id: 'user_1',
  tenantId: 'tenant_1',
  displayName: 'Opal Operator'
};

const pullRequest = {
  id: 'pr_1',
  runId: 'run_1',
  owner,
  tenant: 'tenant_1',
  provider: 'github',
  number: 123,
  url: 'https://github.com/acme/widgets/pull/123',
  state: 'open' as const,
  branch: 'enhancement/widgets-run_1',
  createdAt: '2026-06-22T00:02:00.000Z',
  updatedAt: '2026-06-22T00:02:00.000Z'
};

const session = {
  id: 'sess_1',
  runId: 'run_1',
  phase: 'implementation',
  step: 'implementation.build',
  role: 'implementer',
  round: 1,
  model: { provider: 'anthropic', model: 'claude-sonnet-4' },
  inferenceSettings: {},
  startedAt: '2026-06-22T00:03:00.000Z',
  endedAt: '2026-06-22T00:04:00.000Z',
  durationMs: 60000,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  usageAvailable: false,
  assistantTurnCount: 0,
  toolCallCount: 0,
  outcome: 'succeeded' as const,
  cost: {
    model: { provider: 'anthropic', model: 'claude-sonnet-4' },
    usd: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  }
};

describe('run observability route contracts', () => {
  it('exports run pull-request path and success status', () => {
    expect(runPullRequestPath).toBe('/v1/runs/:id/pull-request');
    expect(getRunPullRequestSuccessStatusCode).toBe(200);
  });

  it('parses strict run pull-request responses', () => {
    expect(runPullRequestResponseSchema.parse({ pullRequest })).toEqual({ pullRequest });
    expect(() => runPullRequestResponseSchema.parse({ pullRequest, extra: true })).toThrow();
  });

  it('exports run sessions path and success status', () => {
    expect(runSessionsPath).toBe('/v1/runs/:id/sessions');
    expect(listRunSessionsSuccessStatusCode).toBe(200);
  });

  it('parses strict run session list responses', () => {
    expect(runSessionListResponseSchema.parse({ sessions: [session] })).toEqual({ sessions: [session] });
    expect(() => runSessionListResponseSchema.parse({ sessions: [session], extra: true })).toThrow();
  });

  it('includes both run observability reads in OpenAPI output', () => {
    const document = generateOpenApiDocument();
    expect(document.paths['/v1/runs/{id}/pull-request']).toBeDefined();
    expect(document.paths['/v1/runs/{id}/sessions']).toBeDefined();
  });
});
