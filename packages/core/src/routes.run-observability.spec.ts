import Fastify, { type FastifyBaseLogger } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  errorResponseSchema,
  getRunPullRequestSuccessStatusCode,
  listRunSessionsSuccessStatusCode,
  pullRequestSchema,
  runPullRequestPath,
  runPullRequestResponseSchema,
  runSessionListResponseSchema,
  runSessionsPath,
  sessionSchema,
  type PullRequest,
  type Session
} from '@autocatalyst/api-contract';

import { ControlPlaneServiceError, type ControlPlaneService } from './control-plane-service.js';
import { registerControlPlaneRoutes, type SafeServerErrorLogFields } from './routes.js';
import type { ControlPlaneRouteDependencies } from './routes.js';
import type { PolicyDecisionInput } from './policy.js';

interface CapturedLogEntry {
  level: string;
  fields: unknown;
  message: string;
}

function createCapturingLogger(): { logger: FastifyBaseLogger; entries: CapturedLogEntry[] } {
  const entries: CapturedLogEntry[] = [];
  const makeLevel = (level: string) => (fields: unknown, msg?: string) => {
    entries.push({ level, fields, message: msg ?? '' });
  };
  const logger: FastifyBaseLogger = {
    fatal: makeLevel('fatal') as FastifyBaseLogger['fatal'],
    error: makeLevel('error') as FastifyBaseLogger['error'],
    warn: makeLevel('warn') as FastifyBaseLogger['warn'],
    info: makeLevel('info') as FastifyBaseLogger['info'],
    debug: makeLevel('debug') as FastifyBaseLogger['debug'],
    trace: makeLevel('trace') as FastifyBaseLogger['trace'],
    silent: makeLevel('silent') as FastifyBaseLogger['silent'],
    level: 'info',
    child: () => logger
  };
  return { logger, entries };
}

function createFakeControlPlaneService(): ControlPlaneService {
  return {
    createConversationWithFirstRun: vi.fn(async () => {
      throw new Error('not stubbed');
    }),
    listRuns: vi.fn(async () => {
      throw new Error('not stubbed');
    }),
    getRun: vi.fn(async () => {
      throw new Error('not stubbed');
    }),
    listRunSteps: vi.fn(async () => {
      throw new Error('not stubbed');
    }),
    subscribeRunEvents: vi.fn(async () => {
      throw new Error('not stubbed');
    }),
    replayRunEvents: vi.fn(async (input) => ({
      status: 'ok' as const,
      events: [] as never[],
      ...(input.lastEventId !== undefined ? {} : {})
    })),
    getRunSpec: vi.fn(async () => {
      throw new Error('not stubbed');
    }),
    createRunFeedback: vi.fn(async () => {
      throw new Error('not stubbed');
    }),
    listRunFeedback: vi.fn(async () => {
      throw new Error('not stubbed');
    }),
    appendRunFeedbackThreadReply: vi.fn(async () => {
      throw new Error('not stubbed');
    }),
    replyToRun: vi.fn(async () => {
      throw new Error('not stubbed');
    }),
    reconcilePullRequests: vi.fn().mockResolvedValue({ checked: 0, merged: 0, closed: 0, failed: 0, timedOut: false }),
    getRunPullRequest: vi.fn(async () => {
      throw new Error('not stubbed');
    }),
    listRunSessions: vi.fn(async () => {
      throw new Error('not stubbed');
    }),
    tick: vi.fn(async () => ({ status: 'noop' as const }))
  };
}

async function buildServer(overrides?: Partial<ControlPlaneRouteDependencies>, loggerInstance?: FastifyBaseLogger) {
  const bearerToken = 'test-token';
  const policyCalls: PolicyDecisionInput[] = [];

  const dependencies: ControlPlaneRouteDependencies = {
    health: { isDatabaseReachable: async () => true },
    auth: { bearerToken },
    policy: { authorize: async (input) => { policyCalls.push(input); return { allowed: true }; } },
    probeResources: {
      create: vi.fn(async () => ({ id: 'probe_123', value: 'x', createdAt: '2026-01-01T00:00:00.000Z' })),
      findById: vi.fn(async () => null)
    },
    configurationRecords: {
      create: vi.fn(async () => ({ id: 'cfg_123', tenant: 'tenant_dev', kind: 'provider_profile' as const, providerKind: 'model_runner' as const, adapterId: 'openai', settings: { profileName: 'default' }, createdAt: '2026-06-08T00:00:00.000Z', updatedAt: '2026-06-08T00:00:00.000Z' })),
      list: vi.fn(async () => []),
      findById: vi.fn(async () => null),
      update: vi.fn(async () => null),
      delete: vi.fn(async () => false)
    },
    secrets: {
      createSecret: vi.fn(async () => ({ handle: 'sec_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef' }))
    },
    controlPlane: createFakeControlPlaneService(),
    ...overrides
  };

  const app = loggerInstance !== undefined
    ? Fastify({ loggerInstance })
    : Fastify({ logger: false });
  await registerControlPlaneRoutes(app, dependencies);
  return { app, authorization: { authorization: `Bearer ${bearerToken}` }, policyCalls, controlPlane: dependencies.controlPlane, policy: dependencies.policy };
}

describe('run observability routes', () => {
  let server: Awaited<ReturnType<typeof buildServer>>['app'] | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  describe('GET /v1/runs/:id/pull-request', () => {
    it('returns the pull request for a run', async () => {
      const pullRequest: PullRequest = pullRequestSchema.parse({
        id: 'pr_1',
        runId: 'run_1',
        owner: { kind: 'human', id: 'user_1', tenantId: 'tenant_dev' },
        tenant: 'tenant_dev',
        provider: 'github',
        number: 42,
        url: 'https://github.com/org/repo/pull/42',
        state: 'open',
        branch: 'feat/my-feature',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      });

      const controlPlane = createFakeControlPlaneService();
      vi.mocked(controlPlane.getRunPullRequest).mockResolvedValue(runPullRequestResponseSchema.parse({ pullRequest }));

      const { app, authorization, policyCalls } = await buildServer({ controlPlane });
      server = app;

      const response = await app.inject({
        method: 'GET',
        url: '/v1/runs/run_1/pull-request',
        headers: authorization
      });

      expect(response.statusCode).toBe(getRunPullRequestSuccessStatusCode);
      expect(response.json()).toEqual({ pullRequest });
      expect(controlPlane.getRunPullRequest).toHaveBeenCalledWith(
        expect.objectContaining({ tenant: 'tenant_dev', runId: 'run_1' })
      );
      expect(policyCalls).toContainEqual(
        expect.objectContaining({
          action: 'run_pull_request.read',
          resource: { kind: 'run_pull_request', id: 'run_1', path: '/v1/runs/:id/pull-request' }
        })
      );
    });

    it('returns 404 when no pull request exists for the run', async () => {
      const controlPlane = createFakeControlPlaneService();
      vi.mocked(controlPlane.getRunPullRequest).mockRejectedValue(
        new ControlPlaneServiceError('not_found', 'Pull request not found.')
      );

      const { app, authorization } = await buildServer({ controlPlane });
      server = app;

      const noPrResponse = await app.inject({
        method: 'GET',
        url: '/v1/runs/run_1/pull-request',
        headers: authorization
      });

      expect(noPrResponse.statusCode).toBe(404);
      expect(noPrResponse.json()).toMatchObject({ error: { code: 'not_found' } });
    });

    it('returns 401 without a valid bearer token', async () => {
      const { app } = await buildServer();
      server = app;

      const response = await app.inject({ method: 'GET', url: '/v1/runs/run_1/pull-request' });
      expect(response.statusCode).toBe(401);
    });

    it('checks policy with correct action and resource kind', async () => {
      const controlPlane = createFakeControlPlaneService();
      vi.mocked(controlPlane.getRunPullRequest).mockRejectedValue(
        new ControlPlaneServiceError('not_found', 'Pull request not found.')
      );

      const { app, authorization, policyCalls } = await buildServer({ controlPlane });
      server = app;

      await app.inject({
        method: 'GET',
        url: '/v1/runs/run_1/pull-request',
        headers: authorization
      });

      expect(policyCalls).toContainEqual(
        expect.objectContaining({
          action: 'run_pull_request.read',
          resource: { kind: 'run_pull_request', id: 'run_1', path: runPullRequestPath }
        })
      );
    });
  });

  describe('GET /v1/runs/:id/sessions', () => {
    it('returns sessions for a run', async () => {
      const session: Session = sessionSchema.parse({
        id: 'sess_1',
        runId: 'run_1',
        phase: 'planning',
        step: 'think',
        role: 'main',
        round: 1,
        model: { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022' },
        inferenceSettings: {},
        startedAt: '2026-01-01T00:00:00.000Z',
        endedAt: '2026-01-01T00:01:00.000Z',
        durationMs: 60000,
        tokens: { input: 100, output: 200, cacheRead: 0, cacheWrite: 0 },
        usageAvailable: true,
        assistantTurnCount: 1,
        toolCallCount: 0,
        outcome: 'succeeded',
        cost: { model: { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022' }, usd: null, tokens: { input: 100, output: 200, cacheRead: 0, cacheWrite: 0 } }
      });

      const controlPlane = createFakeControlPlaneService();
      vi.mocked(controlPlane.listRunSessions).mockResolvedValue(
        { sessions: [session] }
      );

      const { app, authorization, policyCalls } = await buildServer({ controlPlane });
      server = app;

      const sessionResponse = await app.inject({
        method: 'GET',
        url: '/v1/runs/run_1/sessions',
        headers: authorization
      });

      expect(sessionResponse.statusCode).toBe(listRunSessionsSuccessStatusCode);
      expect(sessionResponse.json()).toEqual({ sessions: [session] });
      expect(controlPlane.listRunSessions).toHaveBeenCalledWith(
        expect.objectContaining({ tenant: 'tenant_dev', runId: 'run_1' })
      );
      expect(policyCalls).toContainEqual(
        expect.objectContaining({
          action: 'run_sessions.list',
          resource: { kind: 'run_sessions', id: 'run_1', path: runSessionsPath }
        })
      );
    });

    it('returns 404 when the run does not exist', async () => {
      const controlPlane = createFakeControlPlaneService();
      vi.mocked(controlPlane.listRunSessions).mockRejectedValue(
        new ControlPlaneServiceError('not_found', 'Run not found.')
      );

      const { app, authorization } = await buildServer({ controlPlane });
      server = app;

      const response = await app.inject({
        method: 'GET',
        url: '/v1/runs/run_999/sessions',
        headers: authorization
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'not_found' } });
    });

    it('returns 401 without a valid bearer token', async () => {
      const { app } = await buildServer();
      server = app;

      const response = await app.inject({ method: 'GET', url: '/v1/runs/run_1/sessions' });
      expect(response.statusCode).toBe(401);
    });

    it('checks policy with correct action and resource kind', async () => {
      const controlPlane = createFakeControlPlaneService();
      vi.mocked(controlPlane.listRunSessions).mockResolvedValue({ sessions: [] });

      const { app, authorization, policyCalls } = await buildServer({ controlPlane });
      server = app;

      await app.inject({
        method: 'GET',
        url: '/v1/runs/run_1/sessions',
        headers: authorization
      });

      expect(policyCalls).toContainEqual(
        expect.objectContaining({
          action: 'run_sessions.list',
          resource: { kind: 'run_sessions', id: 'run_1', path: '/v1/runs/:id/sessions' }
        })
      );
    });

    it('validates the response shape', async () => {
      const controlPlane = createFakeControlPlaneService();
      vi.mocked(controlPlane.listRunSessions).mockResolvedValue({ sessions: [] });

      const { app, authorization } = await buildServer({ controlPlane });
      server = app;

      const response = await app.inject({
        method: 'GET',
        url: '/v1/runs/run_1/sessions',
        headers: authorization
      });

      expect(response.statusCode).toBe(200);
      expect(runSessionListResponseSchema.parse(response.json())).toEqual({ sessions: [] });
    });
  });

  describe('5xx logging', () => {
    it('logs route_failure with method and route for persistence_failed service error → 500', async () => {
      const { logger, entries } = createCapturingLogger();
      const controlPlane = createFakeControlPlaneService();
      vi.mocked(controlPlane.listRunSessions).mockRejectedValue(
        new ControlPlaneServiceError('persistence_failed', 'DB write failed.')
      );

      const { app, authorization } = await buildServer({ controlPlane }, logger);
      server = app;

      const response = await app.inject({
        method: 'GET',
        url: '/v1/runs/run_1/sessions',
        headers: authorization
      });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ error: { code: 'internal_error', message: 'An internal server error occurred.' } });

      const routeFailureEntries = entries.filter(
        (e) => typeof e.fields === 'object' && e.fields !== null && (e.fields as Record<string, unknown>)['event'] === 'route_failure'
      );
      expect(routeFailureEntries).toHaveLength(1);
      const logFields = routeFailureEntries[0]!.fields as SafeServerErrorLogFields;
      expect(logFields.event).toBe('route_failure');
      expect(logFields.method).toBe('GET');
      expect(logFields.statusCode).toBe(500);
      expect(logFields.errorCode).toBe('persistence_failed');
    });

    it('does NOT log a server fault for unauthorized service error → 403', async () => {
      const { logger, entries } = createCapturingLogger();
      const controlPlane = createFakeControlPlaneService();
      vi.mocked(controlPlane.listRunSessions).mockRejectedValue(
        new ControlPlaneServiceError('unauthorized', 'Not authorized.')
      );

      const { app, authorization } = await buildServer({ controlPlane }, logger);
      server = app;

      const response = await app.inject({
        method: 'GET',
        url: '/v1/runs/run_1/sessions',
        headers: authorization
      });

      expect(response.statusCode).toBe(403);
      const routeFailureEntries = entries.filter(
        (e) => typeof e.fields === 'object' && e.fields !== null && (e.fields as Record<string, unknown>)['event'] === 'route_failure'
      );
      expect(routeFailureEntries).toHaveLength(0);
    });

    it('does NOT log a server fault for not_found service error → 404', async () => {
      const { logger, entries } = createCapturingLogger();
      const controlPlane = createFakeControlPlaneService();
      vi.mocked(controlPlane.listRunSessions).mockRejectedValue(
        new ControlPlaneServiceError('not_found', 'Run not found.')
      );

      const { app, authorization } = await buildServer({ controlPlane }, logger);
      server = app;

      const response = await app.inject({
        method: 'GET',
        url: '/v1/runs/run_1/sessions',
        headers: authorization
      });

      expect(response.statusCode).toBe(404);
      const routeFailureEntries = entries.filter(
        (e) => typeof e.fields === 'object' && e.fields !== null && (e.fields as Record<string, unknown>)['event'] === 'route_failure'
      );
      expect(routeFailureEntries).toHaveLength(0);
    });

    it('does NOT log a server fault for forbidden service error → 403', async () => {
      const { logger, entries } = createCapturingLogger();
      const controlPlane = createFakeControlPlaneService();
      vi.mocked(controlPlane.listRunSessions).mockRejectedValue(
        new ControlPlaneServiceError('forbidden', 'Access denied.')
      );

      const { app, authorization } = await buildServer({ controlPlane }, logger);
      server = app;

      const response = await app.inject({
        method: 'GET',
        url: '/v1/runs/run_1/sessions',
        headers: authorization
      });

      expect(response.statusCode).toBe(403);
      const routeFailureEntries = entries.filter(
        (e) => typeof e.fields === 'object' && e.fields !== null && (e.fields as Record<string, unknown>)['event'] === 'route_failure'
      );
      expect(routeFailureEntries).toHaveLength(0);
    });

    it('does not include sensitive data (secret sentinels, absolute paths) in route_failure log fields', async () => {
      const { logger, entries } = createCapturingLogger();
      const controlPlane = createFakeControlPlaneService();
      // Use a persistence_failed error containing sensitive data in the stack trace
      const persistenceError = new ControlPlaneServiceError('persistence_failed', 'DB failure.');
      // Simulate a stack with a path and redacted sentinel
      Object.defineProperty(persistenceError, 'stack', {
        value: 'Error: DB failure.\n    at /Users/testuser/project/src/file.ts:1:1\n    with SECRET_SENTINEL\n    with Bearer secrettoken123'
      });
      vi.mocked(controlPlane.listRunSessions).mockRejectedValue(persistenceError);

      const { app, authorization } = await buildServer({ controlPlane }, logger);
      server = app;

      await app.inject({
        method: 'GET',
        url: '/v1/runs/run_1/sessions',
        headers: authorization
      });

      const routeFailureEntries = entries.filter(
        (e) => typeof e.fields === 'object' && e.fields !== null && (e.fields as Record<string, unknown>)['event'] === 'route_failure'
      );
      expect(routeFailureEntries).toHaveLength(1);
      const sanitizedSerialized = JSON.stringify(routeFailureEntries);
      expect(sanitizedSerialized).not.toContain('SECRET_SENTINEL');
      expect(sanitizedSerialized).not.toContain('Bearer secret');
      expect(sanitizedSerialized).not.toContain('/Users/testuser');
    });

    it('unexpected route error → 500 generic client response + log entry', async () => {
      const { logger, entries } = createCapturingLogger();
      const controlPlane = createFakeControlPlaneService();
      vi.mocked(controlPlane.listRunSessions).mockRejectedValue(new Error('unexpected boom'));

      const { app, authorization } = await buildServer({ controlPlane }, logger);
      server = app;

      const response = await app.inject({
        method: 'GET',
        url: '/v1/runs/run_1/sessions',
        headers: authorization
      });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ error: { code: 'internal_error', message: 'An internal server error occurred.' } });

      const routeFailureEntries = entries.filter(
        (e) => typeof e.fields === 'object' && e.fields !== null && (e.fields as Record<string, unknown>)['event'] === 'route_failure'
      );
      expect(routeFailureEntries).toHaveLength(1);
      const logFields = routeFailureEntries[0]!.fields as SafeServerErrorLogFields;
      expect(logFields.event).toBe('route_failure');
      expect(logFields.method).toBe('GET');
      expect(logFields.statusCode).toBe(500);
    });
  });
});
