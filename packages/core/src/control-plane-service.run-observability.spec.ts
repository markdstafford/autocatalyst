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

const timestamp = '2026-06-22T00:00:00.000Z';

const owner = {
  id: 'user_1',
  kind: 'human' as const,
  tenantId: 'tenant_1',
  displayName: 'Ada'
};

const principal: Principal = owner;

function makeRun(overrides?: Partial<Run>): Run {
  return {
    id: 'run_1',
    topicId: 'topic_1',
    owner,
    tenant: 'tenant_1',
    workKind: 'feature',
    currentStep: 'done',
    terminal: true,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides
  };
}

const pullRequest: PullRequest = {
  id: 'pr_1',
  runId: 'run_1',
  owner,
  tenant: 'tenant_1',
  provider: 'github',
  number: 42,
  url: 'https://github.com/test/repo/pull/42',
  state: 'open',
  branch: 'feature-branch',
  createdAt: timestamp,
  updatedAt: timestamp
};

const session: Session = {
  id: 'session_1',
  runId: 'run_1',
  phase: 'implementation',
  step: 'implementation.build',
  role: 'primary',
  round: 0,
  model: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
  inferenceSettings: {},
  startedAt: timestamp,
  endedAt: timestamp,
  durationMs: 1000,
  tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
  usageAvailable: true,
  assistantTurnCount: 2,
  toolCallCount: 5,
  outcome: 'succeeded',
  cost: {
    model: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
    tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 }
  }
};

function makeFakeRunRepo(overrides?: Partial<RunRepository>): RunRepository {
  return {
    create: vi.fn(),
    findById: vi.fn().mockResolvedValue(makeRun()),
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
      clock: () => timestamp
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
    expect(await service.getRunPullRequest({ principal: owner, tenant: 'tenant_1', runId: 'run_1' })).toEqual({ pullRequest });
    expect(pullRequests.findByRun).toHaveBeenCalledWith('run_1');
  });

  it('throws not_found for a missing run', async () => {
    const runs = makeFakeRunRepo({ findById: vi.fn().mockResolvedValue(null) });
    const service = makeService({ runs });
    await expect(service.getRunPullRequest({ principal: owner, tenant: 'tenant_1', runId: 'missing' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('throws not_found for a cross-tenant run', async () => {
    const crossTenantRun = makeRun({ id: 'run_2', tenant: 'tenant_2', owner: { ...owner, tenantId: 'tenant_2' } });
    const runs = makeFakeRunRepo({
      findById: vi.fn().mockImplementation(async (id: string) => {
        if (id === 'run_2') return crossTenantRun;
        return makeRun();
      })
    });
    const service = makeService({ runs });
    await expect(service.getRunPullRequest({ principal: owner, tenant: 'tenant_1', runId: 'run_2' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('throws not_found when no pull request exists for the run', async () => {
    const noPrRun = makeRun({ id: 'run_no_pr' });
    const runs = makeFakeRunRepo({
      findById: vi.fn().mockImplementation(async (id: string) => {
        if (id === 'run_no_pr') return noPrRun;
        return makeRun();
      })
    });
    const pullRequests = makeFakePullRequestRepo({
      findByRun: vi.fn().mockResolvedValue(null)
    });
    const service = makeService({ runs, pullRequests });
    await expect(service.getRunPullRequest({ principal: owner, tenant: 'tenant_1', runId: 'run_no_pr' })).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('DefaultControlPlaneService.listRunSessions', () => {
  it('returns sessions for a valid tenant-owned run', async () => {
    const sessions = makeFakeSessionRepo();
    const service = makeService({ sessions });
    expect(await service.listRunSessions({ principal: owner, tenant: 'tenant_1', runId: 'run_1' })).toEqual({ sessions: [session] });
    expect(sessions.listByRun).toHaveBeenCalledWith('run_1');
  });

  it('throws not_found for a cross-tenant run', async () => {
    const crossTenantRun = makeRun({ id: 'run_2', tenant: 'tenant_2', owner: { ...owner, tenantId: 'tenant_2' } });
    const runs = makeFakeRunRepo({
      findById: vi.fn().mockImplementation(async (id: string) => {
        if (id === 'run_2') return crossTenantRun;
        return makeRun();
      })
    });
    const service = makeService({ runs });
    await expect(service.listRunSessions({ principal: owner, tenant: 'tenant_1', runId: 'run_2' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('throws persistence_failed when sessions repository throws', async () => {
    const persistFailRun = makeRun({ id: 'run_persist_fail' });
    const runs = makeFakeRunRepo({
      findById: vi.fn().mockImplementation(async (id: string) => {
        if (id === 'run_persist_fail') return persistFailRun;
        return makeRun();
      })
    });
    const sessions = makeFakeSessionRepo({
      listByRun: vi.fn().mockRejectedValue(new Error('DB failure'))
    });
    const service = makeService({ runs, sessions });
    await expect(service.listRunSessions({ principal: owner, tenant: 'tenant_1', runId: 'run_persist_fail' })).rejects.toMatchObject({ code: 'persistence_failed' });
  });
});
