import { describe, expect, it, vi } from 'vitest';
import type {
  Principal,
  PullRequest,
  Run,
  Session
} from '@autocatalyst/api-contract';

import { DefaultControlPlaneService } from './control-plane-service.js';
import type { PullRequestRepository, RunRepository, SessionRepository } from './domain-repositories.js';
import { permissivePolicyDecisionPoint } from './policy.js';
import { InMemoryRunEventBus } from './run-events.js';

const owner = {
  kind: 'human' as const,
  id: 'user_1',
  tenantId: 'tenant_1',
  displayName: 'Opal Operator'
};

const principal: Principal = owner;

const run: Run = {
  id: 'run_1',
  topicId: 'topic_1',
  owner,
  tenant: 'tenant_1',
  workKind: 'enhancement',
  currentStep: 'pr.human_review',
  terminal: false,
  createdAt: '2026-06-22T00:00:00.000Z',
  updatedAt: '2026-06-22T00:01:00.000Z',
  waitingOn: 'human' as const
};

const pullRequest: PullRequest = {
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

const session: Session = {
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

function makeFakeRunRepo(overrides?: Partial<RunRepository>): RunRepository {
  return {
    create: vi.fn(),
    findById: vi.fn().mockResolvedValue(run),
    findActiveByTopic: vi.fn().mockResolvedValue(null),
    listByTopic: vi.fn().mockResolvedValue([]),
    listByTenant: vi.fn().mockResolvedValue([]),
    recordRunLifecycleStart: vi.fn(),
    recordRunStepTransition: vi.fn(),
    ...overrides
  } as RunRepository;
}

function makeFakePullRequestRepo(overrides?: Partial<PullRequestRepository>): PullRequestRepository {
  return {
    create: vi.fn(),
    findById: vi.fn().mockResolvedValue(null),
    findByRun: vi.fn().mockResolvedValue(pullRequest),
    updateState: vi.fn(),
    listOpen: vi.fn().mockResolvedValue([]),
    ...overrides
  };
}

function makeFakeSessionRepo(overrides?: Partial<SessionRepository>): SessionRepository {
  return {
    create: vi.fn(),
    findById: vi.fn().mockResolvedValue(null),
    listByRun: vi.fn().mockResolvedValue([session]),
    ...overrides
  };
}

function makeService(options?: {
  runs?: RunRepository;
  pullRequests?: PullRequestRepository;
  sessions?: SessionRepository;
}) {
  return new DefaultControlPlaneService({
    orchestrator: {
      createRun: vi.fn(),
      createConversationWithFirstRun: vi.fn(),
      applyDirective: vi.fn(),
      dispatch: vi.fn(),
      tick: vi.fn().mockResolvedValue({ status: 'noop' }),
      replyToRun: vi.fn(),
      detectMerges: vi.fn()
    },
    runs: options?.runs ?? makeFakeRunRepo(),
    runSteps: {
      create: vi.fn(),
      findById: vi.fn().mockResolvedValue(null),
      listByRun: vi.fn().mockResolvedValue([]),
      updateCheckpoint: vi.fn()
    },
    events: new InMemoryRunEventBus(),
    policy: permissivePolicyDecisionPoint,
    artifacts: {
      create: vi.fn(),
      findById: vi.fn(),
      listByRun: vi.fn(),
      findByRunAndKind: vi.fn().mockResolvedValue(null),
      updateCachedStatus: vi.fn()
    },
    feedback: {
      create: vi.fn(),
      findById: vi.fn(),
      listByRun: vi.fn().mockResolvedValue([]),
      updateStatusAndAppendThread: vi.fn(),
      appendThreadEntry: vi.fn()
    },
    runWorkspaceMetadata: {
      upsert: vi.fn(),
      findByRunId: vi.fn().mockResolvedValue(null)
    },
    workspaceFilesystem: {
      writeFile: vi.fn(),
      readFile: vi.fn().mockResolvedValue('')
    },
    feedbackLifecycle: {
      feedback: {
        create: vi.fn(),
        findById: vi.fn(),
        listByRun: vi.fn().mockResolvedValue([]),
        updateStatusAndAppendThread: vi.fn(),
        appendThreadEntry: vi.fn()
      },
      ids: () => 'id_1',
      clock: () => '2026-06-22T00:00:00.000Z'
    },
    projects: {
      create: vi.fn(),
      findById: vi.fn().mockResolvedValue(null)
    },
    issueReferenceIntakeResolver: {
      resolve: vi.fn()
    },
    pullRequests: options?.pullRequests ?? makeFakePullRequestRepo(),
    sessions: options?.sessions ?? makeFakeSessionRepo()
  });
}

describe('DefaultControlPlaneService.getRunPullRequest', () => {
  it('returns the pull request for a valid tenant-owned run', async () => {
    const pullRequests = makeFakePullRequestRepo();
    const service = makeService({ pullRequests });
    expect(await service.getRunPullRequest({ principal, tenant: 'tenant_1', runId: 'run_1' })).toEqual({ pullRequest });
    expect(pullRequests.findByRun).toHaveBeenCalledWith('run_1');
  });

  it('throws not_found for a missing run', async () => {
    const runs = makeFakeRunRepo({ findById: vi.fn().mockResolvedValue(null) });
    const service = makeService({ runs });
    await expect(service.getRunPullRequest({ principal, tenant: 'tenant_1', runId: 'missing' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('throws not_found for a cross-tenant run', async () => {
    const crossTenantRun: Run = { ...run, id: 'run_2', tenant: 'tenant_2', owner: { ...owner, tenantId: 'tenant_2' } };
    const runs = makeFakeRunRepo({
      findById: vi.fn().mockImplementation(async (id: string) => {
        if (id === 'run_2') return crossTenantRun;
        return run;
      })
    });
    const service = makeService({ runs });
    await expect(service.getRunPullRequest({ principal, tenant: 'tenant_1', runId: 'run_2' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('throws not_found when no pull request exists for the run', async () => {
    const pullRequests = makeFakePullRequestRepo({
      findByRun: vi.fn().mockResolvedValue(null)
    });
    const service = makeService({ pullRequests });
    await expect(service.getRunPullRequest({ principal, tenant: 'tenant_1', runId: 'run_1' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('throws persistence_failed when pullRequests.findByRun throws', async () => {
    const pullRequests = makeFakePullRequestRepo({
      findByRun: vi.fn().mockRejectedValue(new Error('DB failure'))
    });
    const service = makeService({ pullRequests });
    await expect(service.getRunPullRequest({ principal, tenant: 'tenant_1', runId: 'run_1' })).rejects.toMatchObject({ code: 'persistence_failed' });
  });
});

describe('DefaultControlPlaneService.listRunSessions', () => {
  it('returns sessions for a valid tenant-owned run', async () => {
    const sessions = makeFakeSessionRepo();
    const service = makeService({ sessions });
    expect(await service.listRunSessions({ principal, tenant: 'tenant_1', runId: 'run_1' })).toEqual({ sessions: [session] });
    expect(sessions.listByRun).toHaveBeenCalledWith('run_1');
  });

  it('returns empty sessions array when repository returns empty array', async () => {
    const sessions = makeFakeSessionRepo({
      listByRun: vi.fn().mockResolvedValue([])
    });
    const service = makeService({ sessions });
    expect(await service.listRunSessions({ principal, tenant: 'tenant_1', runId: 'run_1' })).toEqual({ sessions: [] });
  });

  it('throws not_found for a cross-tenant run', async () => {
    const crossTenantRun: Run = { ...run, id: 'run_2', tenant: 'tenant_2', owner: { ...owner, tenantId: 'tenant_2' } };
    const runs = makeFakeRunRepo({
      findById: vi.fn().mockImplementation(async (id: string) => {
        if (id === 'run_2') return crossTenantRun;
        return run;
      })
    });
    const service = makeService({ runs });
    await expect(service.listRunSessions({ principal, tenant: 'tenant_1', runId: 'run_2' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('throws persistence_failed when sessions repository throws', async () => {
    const sessions = makeFakeSessionRepo({
      listByRun: vi.fn().mockRejectedValue(new Error('DB failure'))
    });
    const service = makeService({ sessions });
    await expect(service.listRunSessions({ principal, tenant: 'tenant_1', runId: 'run_persist_fail' })).rejects.toMatchObject({ code: 'persistence_failed' });
  });
});
