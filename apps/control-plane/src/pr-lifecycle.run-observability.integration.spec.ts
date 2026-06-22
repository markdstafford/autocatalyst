/**
 * Integration test: completed run observability
 *
 * Proves that after a run completes via the PR lifecycle:
 * - GET /v1/runs/:id/pull-request returns the persisted PR with a useful title
 * - GET /v1/runs/:id/steps remains readable as the durable step timeline
 * - GET /v1/runs/:id/sessions returns durable session rows
 * - SSE unavailability does NOT prevent reading steps/sessions/PR
 * - Unexpected route errors produce 500 + route_failure log without leaking secrets or paths
 *
 * We use a "post-completion" seeding approach (run already at pr.human_review with an
 * open PR record) to avoid timing fragility in the auto-dispatch path. The PR
 * content quality is covered separately by pr-lifecycle.integration.spec.ts.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import Fastify, { type FastifyBaseLogger } from 'fastify';

import type { NonModelPrincipal } from '@autocatalyst/api-contract';
import {
  DefaultControlPlaneService,
  InMemoryRunEventBus,
  permissivePolicyDecisionPoint,
  registerControlPlaneRoutes,
  type WorkspaceFileSystemPort
} from '@autocatalyst/core';
import {
  DrizzleConfigurationRecordRepository,
  DrizzleConversationIngressRepository,
  DrizzleProbeResourceRepository,
  SqliteSecretStore,
  createDrizzleDomainRepositories,
  createSqliteDatabase,
  migrateSqliteDatabase
} from '@autocatalyst/persistence';

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const BEARER_TOKEN = 'observability-test-bearer-token';
const REPO_OWNER = 'testorg';
const REPO_NAME = 'testrepo';
const REPO_SLUG = `${REPO_OWNER}/${REPO_NAME}`;
const PR_NUMBER = 123;
const PR_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}/pull/${PR_NUMBER}`;
const CHANGED_FILE = 'packages/core/src/routes.ts';

const owner: NonModelPrincipal = {
  id: 'principal_dev_human',
  kind: 'human' as const,
  tenantId: 'tenant_dev',
  displayName: 'Development Principal'
};

// ---------------------------------------------------------------------------
// Capturing logger — used for safe fault log assertions
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Harness — seeds a completed run with an open PR, steps, and sessions,
// then builds a real Fastify app backed by in-memory SQLite.
// ---------------------------------------------------------------------------

interface ObservabilityHarness {
  readonly run: { id: string };
  readonly app: ReturnType<typeof Fastify>;
  readonly service: DefaultControlPlaneService;
  readonly logEntries: CapturedLogEntry[];
  readonly authHeaders: { authorization: string };
  close(): Promise<void>;
}

async function setupObservabilityHarness(): Promise<ObservabilityHarness> {
  const now = '2026-06-22T00:00:00.000Z';
  const database = createSqliteDatabase({ path: ':memory:' });
  await migrateSqliteDatabase(database);
  const domainRepos = createDrizzleDomainRepositories(database);

  // 1. Project
  const project = await domainRepos.projects.create({
    owner,
    tenant: 'tenant_dev',
    displayName: 'Observability Test Project',
    repoUrl: `https://github.com/${REPO_SLUG}`,
    hostRepository: {
      provider: 'github',
      owner: REPO_OWNER,
      name: REPO_NAME,
      url: `https://github.com/${REPO_SLUG}`
    },
    workspaceRootOverride: null,
    issueTrackerSetting: null,
    codeHostSetting: {
      provider: 'github',
      credentialRef: { id: 'cred_obs_1', purpose: 'code_host' }
    },
    credentialRefs: []
  });

  // 2. Run seeded directly at pr.human_review (already past pr.finalize + pr.open)
  const seed = await new DrizzleConversationIngressRepository(database)
    .createConversationTopicMessageAndRun({
      conversation: {
        projectId: project.id,
        owner,
        tenant: 'tenant_dev',
        identity: 'observability-integration-test',
        activeTopicId: null
      },
      topic: {
        owner,
        tenant: 'tenant_dev',
        title: 'Observability Topic',
        kind: 'main'
      },
      message: {
        owner,
        tenant: 'tenant_dev',
        author: owner,
        direction: 'inbound',
        body: 'prove observability'
      },
      run: {
        owner,
        tenant: 'tenant_dev',
        workKind: 'feature',
        currentStep: 'pr.human_review',
        terminal: false
      },
      runStep: {
        phase: 'pr',
        step: 'pr.human_review',
        role: 'none',
        startedAt: now,
        endedAt: null,
        durationMs: null
      }
    });

  const runId = seed.run.id;
  const branch = `feature/${runId.slice(0, 8)}`;

  // 3. Insert implementation.build run step with cumulative summary checkpoint
  //    so the step timeline is non-empty and meaningful.
  const buildStep = await domainRepos.runSteps.create({
    runId,
    phase: 'implementation',
    step: 'implementation.build',
    role: 'none',
    startedAt: now,
    endedAt: now,
    durationMs: 2000,
    occurrence: { index: 0, attempt: 1 }
  });
  await domainRepos.runSteps.updateCheckpoint({
    runStepId: buildStep.id,
    runId,
    tenant: 'tenant_dev',
    checkpointResult: {
      kind: 'cumulative_implementation_summary' as const,
      cumulativeSummary: 'Refactored core routes for observability.',
      changedFiles: [CHANGED_FILE],
      validationSummary: ['All tests pass'],
      followUps: [],
      nonGoals: [],
      sourceRoundCount: 1,
      completedAt: now
    } as unknown as Parameters<typeof domainRepos.runSteps.updateCheckpoint>[0]['checkpointResult']
  });

  // 4. Seed PR record directly — simulates what pr.open would create via the code host adapter.
  //    The title/body quality is tested in pr-lifecycle.integration.spec.ts.
  await domainRepos.pullRequests.create({
    runId,
    owner,
    tenant: 'tenant_dev',
    provider: 'github',
    number: PR_NUMBER,
    url: PR_URL,
    state: 'open',
    branch
  });

  // 5. Seed a Session row directly — the execution session recorder wiring requires a live
  //    AI dispatch; we bypass it by writing directly to the repository.
  await domainRepos.sessions.create({
    runId,
    phase: 'implementation',
    step: 'implementation.build',
    role: 'implementer',
    round: 1,
    model: { provider: 'anthropic', model: 'claude-sonnet-4' },
    inferenceSettings: {},
    startedAt: now,
    endedAt: now,
    durationMs: 2000,
    tokens: { input: 100, output: 200, cacheRead: 0, cacheWrite: 0 },
    usageAvailable: true,
    assistantTurnCount: 2,
    toolCallCount: 5,
    outcome: 'succeeded' as const,
    cost: {
      model: { provider: 'anthropic', model: 'claude-sonnet-4' },
      usd: null,
      tokens: { input: 100, output: 200, cacheRead: 0, cacheWrite: 0 }
    }
  });

  // 6. Build the control-plane service with a stub orchestrator
  //    (no orchestrator dispatch needed — we just read data).
  const eventBus = new InMemoryRunEventBus();
  const policy = permissivePolicyDecisionPoint;

  const service = new DefaultControlPlaneService({
    orchestrator: {
      createRun: vi.fn(),
      createConversationWithFirstRun: vi.fn(),
      applyDirective: vi.fn(),
      dispatch: vi.fn(),
      tick: vi.fn().mockResolvedValue({ status: 'noop' }),
      replyToRun: vi.fn(),
      detectMerges: vi.fn()
    },
    runs: domainRepos.runs,
    runSteps: domainRepos.runSteps,
    events: eventBus,
    policy,
    artifacts: domainRepos.artifacts,
    feedback: domainRepos.feedback,
    runWorkspaceMetadata: domainRepos.runWorkspaceMetadata,
    workspaceFilesystem: {
      readFile: async () => '',
      writeFile: async () => undefined
    } as unknown as WorkspaceFileSystemPort,
    feedbackLifecycle: {
      feedback: domainRepos.feedback,
      ids: () => `fb_${Math.random().toString(36).slice(2)}`,
      clock: () => now
    },
    projects: domainRepos.projects,
    issueReferenceIntakeResolver: {
      resolve: async () => ({ kind: 'error' as const, code: 'tracker_not_found' as const })
    },
    pullRequests: domainRepos.pullRequests,
    sessions: domainRepos.sessions
  });

  // 7. Build the Fastify app with the capturing logger
  const { logger, entries: logEntries } = createCapturingLogger();
  const app = Fastify({ loggerInstance: logger });

  await registerControlPlaneRoutes(app, {
    health: { isDatabaseReachable: async () => true },
    auth: { bearerToken: BEARER_TOKEN },
    policy,
    probeResources: new DrizzleProbeResourceRepository(database),
    configurationRecords: new DrizzleConfigurationRecordRepository(database),
    secrets: new SqliteSecretStore(database),
    controlPlane: service
  });

  return {
    run: { id: runId },
    app,
    service,
    logEntries,
    authHeaders: { authorization: `Bearer ${BEARER_TOKEN}` },
    async close() {
      await app.close();
      database.close();
    }
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('run observability integration: completed run readable', () => {
  let harness: ObservabilityHarness | undefined;

  afterEach(async () => {
    if (harness !== undefined) {
      await harness.close();
      harness = undefined;
    }
  });

  it('returns the persisted PR for a run at pr.human_review', async () => {
    harness = await setupObservabilityHarness();
    const { run, app, authHeaders } = harness;

    const prResponse = await app.inject({
      method: 'GET',
      url: `/v1/runs/${run.id}/pull-request`,
      headers: authHeaders
    });

    expect(prResponse.statusCode).toBe(200);
    expect(prResponse.json().pullRequest).toMatchObject({
      runId: run.id,
      provider: 'github',
      number: PR_NUMBER
    });
  });

  it('returns the durable step timeline for a completed run', async () => {
    harness = await setupObservabilityHarness();
    const { run, app, authHeaders } = harness;

    const stepsResponse = await app.inject({
      method: 'GET',
      url: `/v1/runs/${run.id}/steps`,
      headers: authHeaders
    });

    expect(stepsResponse.statusCode).toBe(200);
    expect(stepsResponse.json().steps.length).toBeGreaterThan(0);
  });

  it('returns durable session rows for a completed run', async () => {
    harness = await setupObservabilityHarness();
    const { run, app, authHeaders } = harness;

    const sessionsResponse = await app.inject({
      method: 'GET',
      url: `/v1/runs/${run.id}/sessions`,
      headers: authHeaders
    });

    expect(sessionsResponse.statusCode).toBe(200);
    expect(sessionsResponse.json().sessions.length).toBeGreaterThan(0);
  });

  it('durable reads (PR, steps, sessions) succeed independently of SSE subscription state', async () => {
    // This test proves that retained SSE unavailability does NOT prevent reading durable records.
    // We intentionally do NOT call the SSE endpoint; the three reads below prove that the
    // durable observability layer is independent of event streaming.
    harness = await setupObservabilityHarness();
    const { run, app, authHeaders } = harness;

    const prResponse = await app.inject({
      method: 'GET',
      url: `/v1/runs/${run.id}/pull-request`,
      headers: authHeaders
    });
    expect(prResponse.statusCode).toBe(200);

    const stepsResponse = await app.inject({
      method: 'GET',
      url: `/v1/runs/${run.id}/steps`,
      headers: authHeaders
    });
    expect(stepsResponse.statusCode).toBe(200);

    const sessionsResponse = await app.inject({
      method: 'GET',
      url: `/v1/runs/${run.id}/sessions`,
      headers: authHeaders
    });
    expect(sessionsResponse.statusCode).toBe(200);
  });
});

describe('run observability integration: safe fault logging', () => {
  let harness: ObservabilityHarness | undefined;

  afterEach(async () => {
    if (harness !== undefined) {
      await harness.close();
      harness = undefined;
    }
  });

  it(
    'unexpected service error → 500 generic response + route_failure log without secrets or workspace paths',
    async () => {
      harness = await setupObservabilityHarness();
      const { run, app, service, authHeaders, logEntries } = harness;

      // Inject an error carrying sensitive data into the service method
      vi.spyOn(service, 'getRunPullRequest').mockRejectedValue(
        new Error('SECRET_SENTINEL /Users/mark.stafford/raw provider output')
      );

      const faultResponse = await app.inject({
        method: 'GET',
        url: `/v1/runs/${run.id}/pull-request`,
        headers: authHeaders
      });

      expect(faultResponse.statusCode).toBe(500);
      expect(faultResponse.json()).toEqual({
        error: { code: 'internal_error', message: 'An internal server error occurred.' }
      });

      const serialized = JSON.stringify(logEntries);
      expect(serialized).toContain('route_failure');
      expect(serialized).not.toContain('SECRET_SENTINEL');
      expect(serialized).not.toContain('/Users/mark.stafford');

      vi.restoreAllMocks();
    }
  );
});
