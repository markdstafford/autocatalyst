import { describe, expect, it, vi } from 'vitest';
import type { Conversation, NonModelPrincipal, Project, PullRequest, Run, RunStep, Topic } from '@autocatalyst/api-contract';

import {
  detectPullRequestMerges,
  type PullRequestLifecycleDependencies
} from './pr-lifecycle.js';
import { CodeHostCredentialMissingError, CodeHostError, type CodeHostPort, type CodeHostPullRequestFacts } from './code-host.js';
import type { CodeHostRegistry } from './code-host-registry.js';
import { DefaultOrchestrator, type ApplyOrchestratedDirectiveInput, type OrchestratedRunResult } from './orchestrator.js';
import { InMemoryRetainedRunEventStore } from './run-events.js';
import { RunDispatchQueue } from './run-dispatch-queue.js';
import { RunLifecycleError } from './run-lifecycle.js';
import { PullRequestStateConflictError } from './domain-repositories.js';
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
    findById: vi.fn(async () => makeProject(opts.projectOverrides ?? {})),
    list: vi.fn(async () => []),
    update: vi.fn(async () => null)
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

const key = { tenant, runId: 'run_1' };
const storedTime = '2026-06-16T00:00:00.000Z';
const secretSentinel = 'SECRET_SENTINEL_raw_provider_response';
const mergedFacts = {
  provider: 'github', number: 42, url: 'https://github.com/example/demo/pull/42',
  state: 'merged', branch: 'feature/run_1'
} as const;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function refreshHarness(opts: Parameters<typeof makeDeps>[0] = {}) {
  const { deps, read } = makeDeps(opts);
  let run = makeRun();
  let pr: PullRequest | null = makePullRequest();
  const gate: RunStep = {
    id: 'step_gate', runId: key.runId, step: 'pr.human_review', phase: 'pr', role: 'none',
    startedAt: timestamp, endedAt: null, durationMs: null,
    occurrence: { index: 0, attempt: 1 }, checkpointResult: null
  };
  let activeStep: RunStep | null = gate;
  let count = 0;
  const update = vi.fn<PullRequestRepository['updateState']>(async (input) => {
    if (pr === null) throw new Error('Missing PR');
    if (input.expectedState !== pr.state) throw new PullRequestStateConflictError();
    pr = { ...pr, state: input.state, updatedAt: input.updatedAt };
    return pr;
  });
  const transition = vi.fn<RunRepository['recordRunStepTransition']>(async (input) => {
    run = {
      ...run, currentStep: input.currentStep, terminal: input.terminal,
      ...(input.failureReason === undefined ? {} : { failureReason: input.failureReason })
    };
    const runStep = {
      ...input.runStep, id: `step_${++count}`, runId: input.runId,
      occurrence: { index: count, attempt: 1 }, checkpointResult: input.checkpointResult ?? null
    };
    activeStep = runStep;
    return { run, runStep };
  });
  const findById = vi.fn<RunRepository['findById']>(async () => run);
  const runs: RunRepository = {
    ...deps.runs,
    findById,
    findLatestOpenRunStep: async () => activeStep,
    recordRunStepTransition: transition
  };
  const events = new InMemoryRetainedRunEventStore({ clock: () => timestamp });
  const queue = new RunDispatchQueue({ maxConcurrent: 1 });
  const orchestrator = new DefaultOrchestrator({
    runs, events, clock: () => timestamp,
    conversationIngress: { createConversationTopicMessageAndRun: vi.fn() },
    autoDispatch: { enabled: false },
    dispatchQueue: queue,
    pullRequestOpenDependencies: {
      ...deps,
      pullRequests: { ...deps.pullRequests, findByRun: async () => pr, updateState: update }
    }
  });

  return {
    deps, read, update, transition, findById, orchestrator, queue,
    refresh: () => orchestrator.refreshRunPullRequest(key),
    batch: () => orchestrator.detectMerges(tenant),
    getEvents: () => events.replayAfter({ ...key, replay: 'retained' }),
    setRun: (overrides: Partial<Run>) => { run = makeRun(overrides); },
    setPr: (overrides: Partial<PullRequest> | null) => { pr = overrides === null ? null : makePullRequest(overrides); },
    setGate: (id: string | null) => { activeStep = id === null ? null : { ...gate, id }; }
  };
}

describe('targeted pull request refresh', () => {
  it('returns the persisted open pair without mutation', async () => {
    const h = refreshHarness();
    expect(await h.refresh()).toEqual({ kind: 'refreshed', run: makeRun(), pullRequest: makePullRequest() });
    expect(h.read).toHaveBeenCalledExactlyOnceWith({
      number: 42, target: { provider: 'github', owner: 'example', name: 'demo' }, credential: { token: 'TOKEN_FOR_TEST' }
    });
    expect(h.update).not.toHaveBeenCalled();
    expect(h.transition).not.toHaveBeenCalled();
    expect(await h.getEvents()).toEqual({ status: 'ok', events: [] });
  });

  it.each([
    { currentStep: 'pr.finalize', terminal: false },
    { currentStep: 'failed', terminal: true },
    { currentStep: 'canceled', terminal: true }
  ])('does not read an open PR for a run at $currentStep', async (state) => {
    const h = refreshHarness();
    h.setRun(state);
    expect(await h.refresh()).toEqual({ kind: 'conflict', message: 'Run is not waiting at the pull request gate.' });
    expect(h.read).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });

  it.each([
    { prState: 'merged', runStep: 'failed', failureReason: 'runner_failed' },
    { prState: 'closed', runStep: 'failed', failureReason: 'runner_failed' },
    { prState: 'closed', runStep: 'done', failureReason: undefined }
  ] as const)('conflicts for $prState PR and incompatible $runStep run', async ({ prState, runStep, failureReason }) => {
    const h = refreshHarness();
    h.setRun({ currentStep: runStep, terminal: true, ...(failureReason !== undefined ? { failureReason } : {}) });
    h.setPr({ state: prState });
    expect(await h.refresh()).toEqual({ kind: 'conflict', message: 'The stored pull request outcome does not match the run state.' });
    expect(h.read).not.toHaveBeenCalled();
    expect(h.transition).not.toHaveBeenCalled();
  });

  it.each(['merged', 'closed'] as const)('repairs and replays a stored %s PR', async (state) => {
    const h = refreshHarness();
    const pr = { state, updatedAt: storedTime };
    h.setPr(pr);
    const result = await h.refresh();
    expect(result).toMatchObject({
      kind: 'refreshed', pullRequest: makePullRequest(pr),
      run: state === 'merged'
        ? { currentStep: 'done', terminal: true }
        : { currentStep: 'failed', terminal: true, failureReason: 'pull_request_closed_without_merge' }
    });
    if (state === 'merged') {
      expect(h.transition).toHaveBeenCalledWith(expect.objectContaining({
        checkpointResult: { kind: 'pull_request_merged', provider: 'github', number: 42, url: mergedFacts.url, mergedAt: storedTime }
      }));
    }
    expect(await h.refresh()).toEqual(result);
    expect(h.read).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
    expect(h.transition).toHaveBeenCalledTimes(1);
    expect(await h.getEvents()).toMatchObject({ status: 'ok', events: [{ type: 'run_state_transition' }] });
  });

  it('masks missing and foreign records and faults on a missing open gate occurrence', async () => {
    const h = refreshHarness();
    h.findById.mockResolvedValueOnce(null);
    expect(await h.refresh()).toEqual({ kind: 'not_found', resource: 'run' });
    h.setRun({ tenant: 'other' });
    expect(await h.refresh()).toEqual({ kind: 'not_found', resource: 'run' });
    h.setRun({});
    h.setPr(null);
    expect(await h.refresh()).toEqual({ kind: 'not_found', resource: 'pull_request' });
    h.setPr({ tenant: 'other' });
    expect(await h.refresh()).toEqual({ kind: 'not_found', resource: 'pull_request' });
    h.setPr({});
    h.setGate(null);
    expect(await h.refresh()).toEqual({ kind: 'internal_failure' });
    expect(h.read).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });

  it.each([
    ['null setting', { projectOverrides: { codeHostSetting: null } }, 'credential_missing'],
    ['missing ref', { projectOverrides: { codeHostSetting: { provider: 'github' } } }, 'credential_missing'],
    ['typed resolver rejection', { resolveCredential: async () => { throw new CodeHostCredentialMissingError(); } }, 'credential_missing'],
    ['resolver fault', { resolveCredential: async () => { throw new Error(secretSentinel); } }, null]
  ] as const)('distinguishes %s without reading or writing', async (_label, opts, reason) => {
    const h = refreshHarness(opts);
    expect(await h.refresh()).toEqual(reason === null ? { kind: 'internal_failure' } : { kind: 'read_failed', reason });
    expect(h.read).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
    expect(h.transition).not.toHaveBeenCalled();
  });

  it.each([
    ['authentication_failed', 'authentication_failed'],
    ['resource_not_found', 'not_found'],
    ['provider_unavailable', 'provider_unavailable'],
    ['unsafe_provider_error', 'provider_unavailable']
  ] as const)('classifies a port %s without exposing its output', async (code, reason) => {
    const h = refreshHarness();
    h.read.mockRejectedValueOnce(new CodeHostError(code, secretSentinel, { url: secretSentinel }));
    expect(await h.refresh()).toEqual({ kind: 'read_failed', reason });
    expect(h.update).not.toHaveBeenCalled();
    expect(h.transition).not.toHaveBeenCalled();
  });

  it('separates unsupported providers, invalid provider facts, and missing local records', async () => {
    const h = refreshHarness();
    vi.mocked(h.deps.codeHosts.get).mockImplementationOnce(() => { throw new CodeHostError('unsupported_provider', secretSentinel); });
    expect(await h.refresh()).toEqual({ kind: 'read_failed', reason: 'provider_unavailable' });
    expect(h.read).not.toHaveBeenCalled();
    h.read.mockResolvedValueOnce({ ...mergedFacts, state: 'unknown' });
    expect(await h.refresh()).toEqual({ kind: 'read_failed', reason: 'provider_unavailable' });
    h.read.mockResolvedValueOnce({ ...mergedFacts, number: 999 });
    expect(await h.refresh()).toEqual({ kind: 'read_failed', reason: 'provider_unavailable' });
    vi.mocked(h.deps.topics.findById).mockResolvedValueOnce(null);
    expect(await h.refresh()).toEqual({ kind: 'internal_failure' });
    expect(h.update).not.toHaveBeenCalled();
    expect(h.transition).not.toHaveBeenCalled();
  });

  it('re-reads a typed write conflict, but treats an ordinary write fault as internal', async () => {
    const h = refreshHarness({ facts: mergedFacts });
    h.update.mockRejectedValueOnce(new Error('PullRequest state mismatch. ' + secretSentinel));
    expect(await h.refresh()).toEqual({ kind: 'internal_failure' });
    h.update.mockRejectedValueOnce(new PullRequestStateConflictError());
    expect(await h.refresh()).toEqual({ kind: 'internal_failure' });
    h.update.mockImplementationOnce(async () => {
      h.setPr(null);
      throw new PullRequestStateConflictError();
    });
    expect(await h.refresh()).toEqual({ kind: 'not_found', resource: 'pull_request' });
    expect(h.transition).not.toHaveBeenCalled();
    h.setPr({});
    h.update.mockImplementationOnce(async () => {
      h.setPr({ state: 'closed' });
      throw new PullRequestStateConflictError();
    });
    expect(await h.refresh()).toMatchObject({
      kind: 'refreshed', pullRequest: { state: 'closed' }, run: { currentStep: 'failed' }
    });
  });

  it('releases the lock after a directive fault; a later request repairs without another host read', async () => {
    const h = refreshHarness({ facts: mergedFacts });
    h.transition.mockRejectedValueOnce(new Error(secretSentinel));
    expect(await h.refresh()).toEqual({ kind: 'internal_failure' });
    expect(await h.getEvents()).toEqual({ status: 'ok', events: [] });
    expect(await h.refresh()).toMatchObject({ kind: 'refreshed', pullRequest: { state: 'merged' }, run: { currentStep: 'done' } });
    expect(h.read).toHaveBeenCalledTimes(1);
    expect(h.update).toHaveBeenCalledTimes(1);
    expect(await h.getEvents()).toMatchObject({ events: [{ type: 'run_state_transition' }] });
  });

  it.each([
    ['terminal_run', 'done', 'refreshed'],
    ['terminal_run', 'canceled', 'conflict'],
    ['invalid_transition', 'pr.finalize', 'conflict'],
    ['invalid_transition', 'pr.human_review', 'internal_failure']
  ] as const)('re-reads after %s and handles persisted %s without retry', async (code, step, kind) => {
    const h = refreshHarness({ facts: mergedFacts });
    h.transition.mockImplementationOnce(async () => {
      h.setRun({ currentStep: step, terminal: step === 'done' || step === 'canceled' });
      throw new RunLifecycleError(code, secretSentinel);
    });
    expect(await h.refresh()).toMatchObject({ kind });
    expect(h.transition).toHaveBeenCalledTimes(1);
  });

  it.each(['cancel', 'revise', 'reenter', 'replace'] as const)('rejects an observation made before %s', async (change) => {
    const h = refreshHarness();
    const started = deferred<void>();
    const unblock = deferred<typeof mergedFacts>();
    h.read.mockImplementationOnce(() => { started.resolve(); return unblock.promise; });
    const refreshing = h.refresh();
    await started.promise;
    if (change === 'replace') {
      h.setPr({ id: 'replacement_pr' });
    } else {
      await h.orchestrator.applyDirective({ ...key, directive: change === 'cancel' ? 'cancel' : 'revise', origin: 'human' });
      if (change === 'reenter') {
        await h.orchestrator.applyDirective({ ...key, directive: 'advance', origin: 'system' });
        await h.orchestrator.applyDirective({ ...key, directive: 'advance', origin: 'system' });
      }
    }
    unblock.resolve(mergedFacts);
    expect(await refreshing).toMatchObject({ kind: 'conflict' });
    expect(h.update).not.toHaveBeenCalled();
  });

  it('returns a failed read even if an independent check succeeds while that read is in flight', async () => {
    const h = refreshHarness({ facts: mergedFacts });
    const started = deferred<void>();
    const blocked = deferred<typeof mergedFacts>();
    h.read.mockImplementationOnce(() => { started.resolve(); return blocked.promise; });
    const refreshing = h.refresh();
    await started.promise;
    expect(await h.refresh()).toMatchObject({ kind: 'refreshed', run: { currentStep: 'done' } });
    blocked.reject(new CodeHostError('provider_unavailable', secretSentinel));
    expect(await refreshing).toEqual({ kind: 'read_failed', reason: 'provider_unavailable' });
    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.transition).toHaveBeenCalledTimes(1);
  });

  it('refreshes under dispatch saturation while sharing the batch commit lock', async () => {
    const h = refreshHarness({ facts: mergedFacts });
    const dispatch = deferred<void>();
    const blockedDispatch = h.queue.enqueueForRun('unrelated_run', () => dispatch.promise);
    const readEntered = deferred<void>();
    const finishRead = deferred<typeof mergedFacts>();
    const betweenWrites = deferred<void>();
    const finishTransition = deferred<void>();
    h.read.mockImplementationOnce(() => { readEntered.resolve(); return finishRead.promise; });
    const commit = h.transition.getMockImplementation()!;
    h.transition.mockImplementationOnce(async (input) => {
      betweenWrites.resolve();
      await finishTransition.promise;
      return commit(input);
    });
    try {
      const refreshing = h.refresh();
      await readEntered.promise;
      const batch = h.batch();
      await betweenWrites.promise;
      const findCalls = h.findById.mock.calls.length;
      finishRead.resolve(mergedFacts);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(h.findById).toHaveBeenCalledTimes(findCalls);
      finishTransition.resolve();
      expect(await batch).toEqual({ checked: 0, merged: 1, closed: 0, failed: 0, timedOut: false });
      expect(await refreshing).toMatchObject({ kind: 'refreshed', pullRequest: { state: 'merged' }, run: { currentStep: 'done' } });
      expect(h.queue.activeCount).toBe(1);
      expect(h.update).toHaveBeenCalledTimes(1);
      expect(await h.getEvents()).toMatchObject({ events: [{ type: 'run_state_transition' }] });
    } finally {
      dispatch.resolve();
      finishTransition.resolve();
      await blockedDispatch;
    }
  });
});
