import { describe, expect, it, vi } from 'vitest';
import type { Conversation, NonModelPrincipal, Project, PullRequest, Run, Topic } from '@autocatalyst/api-contract';

import {
  detectPullRequestMerges,
  type PullRequestLifecycleDependencies
} from './pr-lifecycle.js';
import { CodeHostError, type CodeHostPort, type CodeHostPullRequestFacts } from './code-host.js';
import type { CodeHostRegistry } from './code-host-registry.js';
import type { ApplyOrchestratedDirectiveInput, OrchestratedRunResult } from './orchestrator.js';
import type {
  ConversationRepository,
  ProjectRepository,
  PullRequestRepository,
  RunRepository,
  TopicRepository
} from './domain-repositories.js';

const owner: NonModelPrincipal = { id: 'user_1', kind: 'human', tenantId: 'tenant_1', displayName: 'Ada' };
const timestamp = '2026-06-17T00:00:00.000Z';
const tenant = 'tenant_1';

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run_1',
    topicId: 'topic_1',
    owner,
    tenant,
    workKind: 'feature',
    currentStep: 'pr.human_review',
    terminal: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides
  };
}

function makeTopic(overrides: Partial<Topic> = {}): Topic {
  return {
    id: 'topic_1',
    conversationId: 'conv_1',
    owner,
    tenant,
    title: 'Topic',
    kind: 'main',
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides
  };
}

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv_1',
    projectId: 'proj_1',
    owner,
    tenant,
    identity: 'identity_1',
    activeTopicId: 'topic_1',
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides
  };
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj_1',
    owner,
    tenant,
    displayName: 'Demo',
    repoUrl: 'https://github.com/example/demo',
    hostRepository: { provider: 'github', owner: 'example', name: 'demo', url: 'https://github.com/example/demo' },
    workspaceRootOverride: null,
    issueTrackerSetting: null,
    codeHostSetting: { provider: 'github', credentialRef: { id: 'cred_1', purpose: 'code_host' } },
    credentialRefs: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides
  };
}

function makePullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    id: 'pr_1',
    runId: 'run_1',
    owner,
    tenant,
    provider: 'github',
    number: 42,
    url: 'https://github.com/example/demo/pull/42',
    state: 'open',
    branch: 'feature/run_1',
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides
  };
}

interface DepHandles {
  readonly deps: PullRequestLifecycleDependencies;
  readonly read: ReturnType<typeof vi.fn>;
  readonly updateState: ReturnType<typeof vi.fn>;
  readonly applyDirective: ReturnType<typeof vi.fn>;
  readonly listOpen: ReturnType<typeof vi.fn>;
}

function makeDeps(opts: {
  pullRequests?: readonly PullRequest[];
  runs?: ReadonlyMap<string, Run>;
  facts?: CodeHostPullRequestFacts | ((pr: { number: number }) => CodeHostPullRequestFacts);
  readBehavior?: (input: { target: unknown; number: number }) => Promise<CodeHostPullRequestFacts>;
  projectOverrides?: Partial<Project>;
  resolveCredential?: PullRequestLifecycleDependencies['resolveCredential'];
  applyDirectiveBehavior?: (input: ApplyOrchestratedDirectiveInput) => Promise<OrchestratedRunResult>;
  now?: () => number;
} = {}): DepHandles {
  const prs = opts.pullRequests ?? [makePullRequest()];
  const runsMap = opts.runs ?? new Map<string, Run>(prs.map((p) => [p.runId, makeRun({ id: p.runId })]));

  const listOpen = vi.fn().mockResolvedValue(prs);
  const updateState = vi.fn().mockImplementation(async () => makePullRequest());
  const pullRequests: PullRequestRepository = {
    create: vi.fn(),
    findById: vi.fn(),
    findByRun: vi.fn(),
    updateState,
    listOpen
  };
  const runs: RunRepository = {
    create: vi.fn(),
    findById: vi.fn(async (id: string) => runsMap.get(id) ?? null),
    findActiveByTopic: vi.fn(),
    listByTopic: vi.fn(),
    listByTenant: vi.fn(),
    recordRunLifecycleStart: vi.fn(),
    recordRunStepTransition: vi.fn()
  };
  const topics: TopicRepository = {
    create: vi.fn(),
    findById: vi.fn(async () => makeTopic()),
    listByConversation: vi.fn()
  };
  const conversations: ConversationRepository = {
    create: vi.fn(),
    findById: vi.fn(async () => makeConversation()),
    setActiveTopic: vi.fn()
  };
  const projects: ProjectRepository = {
    create: vi.fn(),
    findById: vi.fn(async () => makeProject(opts.projectOverrides ?? {}))
  };

  const defaultFacts: CodeHostPullRequestFacts = {
    provider: 'github',
    number: 42,
    url: 'https://github.com/example/demo/pull/42',
    state: 'open',
    branch: 'feature/run_1'
  };
  const read = vi.fn().mockImplementation(
    opts.readBehavior ?? (async (input: { number: number }) => {
      if (typeof opts.facts === 'function') return opts.facts({ number: input.number });
      return opts.facts ?? defaultFacts;
    })
  );
  const codeHostPort: CodeHostPort = {
    create: vi.fn(),
    read,
    findByBranch: vi.fn(),
    update: vi.fn(),
    merge: vi.fn()
  };
  const codeHosts: CodeHostRegistry = { get: vi.fn().mockReturnValue(codeHostPort) };

  const applyDirective = vi.fn(
    opts.applyDirectiveBehavior ??
      (async (input: ApplyOrchestratedDirectiveInput): Promise<OrchestratedRunResult> => ({
        run: makeRun({ id: input.runId, currentStep: 'done', terminal: true }),
        runStep: {
          id: 'step_done',
          runId: input.runId,
          phase: null,
          step: 'done',
          role: 'none',
          startedAt: timestamp,
          endedAt: timestamp,
          durationMs: 0,
          occurrence: { index: 0, attempt: 1 },
          checkpointResult: input.checkpointResult ?? null
        }
      }))
  );

  const resolveCredential = opts.resolveCredential ?? (async () => ({ token: 'TOKEN_FOR_TEST' }));

  return {
    deps: {
      runs,
      conversations,
      topics,
      projects,
      pullRequests,
      codeHosts,
      resolveCredential,
      applyDirective,
      clock: () => timestamp,
      ...(opts.now !== undefined ? { now: opts.now } : {})
    },
    read,
    updateState,
    applyDirective,
    listOpen
  };
}

describe('detectPullRequestMerges', () => {
  it('returns checked count and leaves state alone when provider says open', async () => {
    const { deps, updateState, applyDirective } = makeDeps();

    const result = await detectPullRequestMerges({ tenant, maxCount: 50, timeoutMs: 30_000 }, deps);

    expect(result).toEqual({ checked: 1, merged: 0, closed: 0, failed: 0, timedOut: false });
    expect(updateState).not.toHaveBeenCalled();
    expect(applyDirective).not.toHaveBeenCalled();
  });

  it('updates state to merged and advances the run when provider says merged', async () => {
    const facts: CodeHostPullRequestFacts = {
      provider: 'github',
      number: 42,
      url: 'https://github.com/example/demo/pull/42',
      state: 'merged',
      branch: 'feature/run_1'
    };
    const { deps, updateState, applyDirective } = makeDeps({ facts });

    const result = await detectPullRequestMerges({ tenant, maxCount: 50, timeoutMs: 30_000 }, deps);

    expect(result).toEqual({ checked: 0, merged: 1, closed: 0, failed: 0, timedOut: false });
    expect(updateState).toHaveBeenCalledWith({
      runId: 'run_1',
      tenant,
      state: 'merged',
      updatedAt: timestamp,
      expectedState: 'open'
    });
    expect(applyDirective).toHaveBeenCalledTimes(1);
    const call = applyDirective.mock.calls[0]?.[0] as ApplyOrchestratedDirectiveInput;
    expect(call.directive).toBe('advance');
    expect(call.origin).toBe('system');
    expect(call.runId).toBe('run_1');
    expect(call.tenant).toBe(tenant);
    const checkpoint = call.checkpointResult as { kind: string; provider: string; number: number; url: string; mergedAt: string };
    expect(checkpoint.kind).toBe('pull_request_merged');
    expect(checkpoint.number).toBe(42);
    expect(checkpoint.url).toBe('https://github.com/example/demo/pull/42');
    expect(checkpoint.mergedAt).toBe(timestamp);
  });

  it('updates state to closed, fails the run with pull_request_closed_without_merge, and does NOT advance it', async () => {
    const facts: CodeHostPullRequestFacts = {
      provider: 'github',
      number: 42,
      url: 'https://github.com/example/demo/pull/42',
      state: 'closed',
      branch: 'feature/run_1'
    };
    const applyDirectiveCalls: ApplyOrchestratedDirectiveInput[] = [];
    const applyDirectiveBehavior = async (input: ApplyOrchestratedDirectiveInput): Promise<OrchestratedRunResult> => {
      applyDirectiveCalls.push(input);
      return {
        run: makeRun({ id: input.runId, currentStep: 'done', terminal: true }),
        runStep: {
          id: 'step_done',
          runId: input.runId,
          phase: null,
          step: 'done',
          role: 'none',
          startedAt: timestamp,
          endedAt: timestamp,
          durationMs: 0,
          occurrence: { index: 0, attempt: 1 },
          checkpointResult: null
        }
      };
    };
    const { deps, updateState } = makeDeps({ facts, applyDirectiveBehavior });

    const result = await detectPullRequestMerges({ tenant, maxCount: 50, timeoutMs: 30_000 }, deps);

    // Result counts closed: 1
    expect(result).toEqual({ checked: 0, merged: 0, closed: 1, failed: 0, timedOut: false });

    // State updated to closed
    expect(updateState).toHaveBeenCalledWith(expect.objectContaining({ state: 'closed' }));

    // applyDirective called with fail directive and reason
    expect(applyDirectiveCalls).toContainEqual(expect.objectContaining({
      directive: 'fail',
      reason: 'pull_request_closed_without_merge'
    }));

    // Run is NOT advanced
    expect(applyDirectiveCalls).not.toContainEqual(expect.objectContaining({ directive: 'advance' }));
  });

  it('respects maxCount via the listOpen limit', async () => {
    const prs = [
      makePullRequest({ id: 'pr_a', runId: 'run_a', number: 1 }),
      makePullRequest({ id: 'pr_b', runId: 'run_b', number: 2 })
    ];
    const runsMap = new Map<string, Run>([
      ['run_a', makeRun({ id: 'run_a' })],
      ['run_b', makeRun({ id: 'run_b' })]
    ]);
    const { deps, read, listOpen } = makeDeps({ pullRequests: prs, runs: runsMap });

    const result = await detectPullRequestMerges({ tenant, maxCount: 2, timeoutMs: 30_000 }, deps);

    expect(listOpen).toHaveBeenCalledWith({ tenant, limit: 2 });
    expect(read).toHaveBeenCalledTimes(2);
    expect(result.checked).toBe(2);
  });

  it('stops iteration and sets timedOut when elapsed exceeds timeoutMs', async () => {
    const prs = [
      makePullRequest({ id: 'pr_a', runId: 'run_a', number: 1 }),
      makePullRequest({ id: 'pr_b', runId: 'run_b', number: 2 }),
      makePullRequest({ id: 'pr_c', runId: 'run_c', number: 3 })
    ];
    const runsMap = new Map<string, Run>([
      ['run_a', makeRun({ id: 'run_a' })],
      ['run_b', makeRun({ id: 'run_b' })],
      ['run_c', makeRun({ id: 'run_c' })]
    ]);
    // First call: t=0 (start). Each loop iteration calls now() once more.
    // start=0; iter1 sees 0 (proceed); iter2 sees 999 (proceed); iter3 sees 1500 (stop).
    let tick = 0;
    const samples = [0, 0, 999, 1500];
    const now = vi.fn(() => {
      const s = samples[Math.min(tick, samples.length - 1)] ?? 1500;
      tick += 1;
      return s;
    });
    const { deps, read } = makeDeps({ pullRequests: prs, runs: runsMap, now });

    const result = await detectPullRequestMerges({ tenant, maxCount: 10, timeoutMs: 1000 }, deps);

    expect(result.timedOut).toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
    expect(result.checked).toBe(2);
  });

  it('counts a CodeHostError on read as failed and continues to next PR', async () => {
    const prs = [
      makePullRequest({ id: 'pr_a', runId: 'run_a', number: 1 }),
      makePullRequest({ id: 'pr_b', runId: 'run_b', number: 2 })
    ];
    const runsMap = new Map<string, Run>([
      ['run_a', makeRun({ id: 'run_a' })],
      ['run_b', makeRun({ id: 'run_b' })]
    ]);
    const readBehavior = async (input: { number: number }): Promise<CodeHostPullRequestFacts> => {
      if (input.number === 1) {
        throw new CodeHostError('provider_unavailable', 'boom');
      }
      return {
        provider: 'github',
        number: input.number,
        url: 'https://github.com/example/demo/pull/2',
        state: 'open',
        branch: 'feature/run_b'
      };
    };
    const { deps } = makeDeps({ pullRequests: prs, runs: runsMap, readBehavior });

    const result = await detectPullRequestMerges({ tenant, maxCount: 10, timeoutMs: 30_000 }, deps);

    expect(result).toEqual({ checked: 1, merged: 0, closed: 0, failed: 1, timedOut: false });
  });

  it('counts missing code-host configuration as failed', async () => {
    const { deps } = makeDeps({ projectOverrides: { codeHostSetting: null } });

    const result = await detectPullRequestMerges({ tenant, maxCount: 50, timeoutMs: 30_000 }, deps);

    expect(result).toEqual({ checked: 0, merged: 0, closed: 0, failed: 1, timedOut: false });
  });

  it('counts an applyDirective failure as failed without crashing the batch', async () => {
    const facts: CodeHostPullRequestFacts = {
      provider: 'github',
      number: 42,
      url: 'https://github.com/example/demo/pull/42',
      state: 'merged',
      branch: 'feature/run_1'
    };
    const applyDirectiveBehavior = async (): Promise<OrchestratedRunResult> => {
      throw new Error('apply failed');
    };
    const { deps, updateState } = makeDeps({ facts, applyDirectiveBehavior });

    const result = await detectPullRequestMerges({ tenant, maxCount: 50, timeoutMs: 30_000 }, deps);

    expect(result).toEqual({ checked: 0, merged: 0, closed: 0, failed: 1, timedOut: false });
    expect(updateState).toHaveBeenCalled();
  });
});
