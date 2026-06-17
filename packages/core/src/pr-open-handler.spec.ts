import { describe, expect, it, vi } from 'vitest';
import type { Conversation, NonModelPrincipal, Project, PullRequest, Run, RunStep, Topic } from '@autocatalyst/api-contract';

import { handlePullRequestOpen, PullRequestOpenHandlerError, type PullRequestOpenCheckpoint, type PullRequestOpenHandlerDependencies } from './pr-open-handler.js';
import { CodeHostError, type CodeHostPort, type CodeHostPullRequestFacts } from './code-host.js';
import type { CodeHostRegistry } from './code-host-registry.js';
import type { ApplyOrchestratedDirectiveInput, OrchestratedRunResult } from './orchestrator.js';
import type {
  ConversationRepository,
  ProjectRepository,
  PullRequestRepository,
  RunRepository,
  RunStepRepository,
  RunWorkspaceMetadataRepository,
  TopicRepository
} from './domain-repositories.js';
import type { RunEventPublisher } from './run-events.js';

const owner: NonModelPrincipal = { id: 'user_1', kind: 'human', tenantId: 'tenant_1', displayName: 'Ada' };
const timestamp = '2026-06-08T00:00:00.000Z';

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run_1',
    topicId: 'topic_1',
    owner,
    tenant: 'tenant_1',
    workKind: 'feature',
    currentStep: 'pr.open',
    terminal: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides
  };
}

function makeTopic(): Topic {
  return {
    id: 'topic_1',
    conversationId: 'conv_1',
    owner,
    tenant: 'tenant_1',
    title: 'Topic',
    kind: 'main',
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function makeConversation(): Conversation {
  return {
    id: 'conv_1',
    projectId: 'proj_1',
    owner,
    tenant: 'tenant_1',
    identity: 'identity_1',
    activeTopicId: 'topic_1',
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj_1',
    owner,
    tenant: 'tenant_1',
    displayName: 'Demo',
    repoUrl: 'https://github.com/example/demo',
    hostRepository: { provider: 'github', owner: 'example', name: 'demo', url: 'https://github.com/example/demo' },
    workspaceRootOverride: null,
    issueTrackerSetting: null,
    codeHostSetting: {
      provider: 'github',
      credentialRef: { id: 'cred_1', purpose: 'code_host' }
    },
    credentialRefs: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides
  };
}

function makeRunStep(overrides: Partial<RunStep> = {}): RunStep {
  return {
    id: 'step_x',
    runId: 'run_1',
    phase: null,
    step: 'pr.finalize',
    role: 'none',
    startedAt: timestamp,
    endedAt: null,
    durationMs: null,
    occurrence: { index: 0, attempt: 1 },
    checkpointResult: null,
    ...overrides
  };
}

function makePullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    id: 'pr_1',
    runId: 'run_1',
    owner,
    tenant: 'tenant_1',
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

const cumulativeSummaryCheckpoint = {
  kind: 'cumulative_implementation_summary' as const,
  cumulativeSummary: 'Added a feature.',
  changedFiles: ['src/feature.ts'],
  validationSummary: ['pnpm test passes'],
  followUps: [],
  nonGoals: [],
  sourceRoundCount: 1,
  completedAt: timestamp
};

const finalizeCheckpoint = {
  kind: 'pull_request_finalize' as const,
  directive: 'advance' as const,
  reconciledSummary: 'Reconciled summary text.',
  titleSubject: 'add the feature',
  validationSummary: [],
  findings: [],
  completedAt: timestamp
};

interface DepHandles {
  readonly deps: PullRequestOpenHandlerDependencies;
  readonly applyDirective: ReturnType<typeof vi.fn>;
  readonly create: ReturnType<typeof vi.fn>;
  readonly read: ReturnType<typeof vi.fn>;
  readonly findByBranch: ReturnType<typeof vi.fn>;
  readonly pullRequestCreate: ReturnType<typeof vi.fn>;
  readonly pullRequestUpdateState: ReturnType<typeof vi.fn>;
  readonly eventsAppend: ReturnType<typeof vi.fn>;
}

function makeDeps(opts: {
  run?: Run;
  existingPullRequest?: PullRequest | null;
  runSteps?: readonly RunStep[];
  facts?: CodeHostPullRequestFacts;
  projectOverrides?: Partial<Project>;
  resolveCredential?: PullRequestOpenHandlerDependencies['resolveCredential'];
  createBehavior?: () => Promise<CodeHostPullRequestFacts>;
  readBehavior?: () => Promise<CodeHostPullRequestFacts>;
  findByBranchBehavior?: () => Promise<CodeHostPullRequestFacts | null>;
  pullRequestCreateBehavior?: () => Promise<PullRequest>;
} = {}): DepHandles {
  const run = opts.run ?? makeRun();
  const runs: RunRepository = {
    create: vi.fn(),
    findById: vi.fn().mockResolvedValue(run),
    findActiveByTopic: vi.fn(),
    listByTopic: vi.fn(),
    listByTenant: vi.fn(),
    recordRunLifecycleStart: vi.fn(),
    recordRunStepTransition: vi.fn()
  };
  const conversations: ConversationRepository = {
    create: vi.fn(),
    findById: vi.fn().mockResolvedValue(makeConversation()),
    setActiveTopic: vi.fn()
  };
  const topics: TopicRepository = {
    create: vi.fn(),
    findById: vi.fn().mockResolvedValue(makeTopic()),
    listByConversation: vi.fn()
  };
  const projects: ProjectRepository = {
    create: vi.fn(),
    findById: vi.fn().mockResolvedValue(makeProject(opts.projectOverrides ?? {}))
  };
  const pullRequestCreate = vi.fn().mockImplementation(
    opts.pullRequestCreateBehavior ?? (async (input: { number: number; url: string; provider: string; state: PullRequest['state']; branch: string }) =>
      makePullRequest({
        number: input.number,
        url: input.url,
        provider: input.provider,
        state: input.state,
        branch: input.branch
      }))
  );
  const pullRequestUpdateState = vi.fn().mockResolvedValue(makePullRequest({ state: 'merged' }));
  const pullRequests: PullRequestRepository = {
    create: pullRequestCreate,
    findById: vi.fn(),
    findByRun: vi.fn().mockResolvedValue(opts.existingPullRequest ?? null),
    updateState: pullRequestUpdateState,
    listOpen: vi.fn()
  };
  const defaultSteps: readonly RunStep[] = [
    makeRunStep({ id: 'step_build', step: 'implementation.build', checkpointResult: cumulativeSummaryCheckpoint as unknown as RunStep['checkpointResult'] }),
    makeRunStep({ id: 'step_fin', step: 'pr.finalize', checkpointResult: finalizeCheckpoint as unknown as RunStep['checkpointResult'] })
  ];
  const runSteps: RunStepRepository = {
    create: vi.fn(),
    findById: vi.fn(),
    listByRun: vi.fn().mockResolvedValue(opts.runSteps ?? defaultSteps),
    updateCheckpoint: vi.fn()
  };
  const runWorkspaceMetadata: RunWorkspaceMetadataRepository = {
    upsert: vi.fn(),
    findByRunId: vi.fn().mockResolvedValue({
      runId: 'run_1',
      workspaceHandle: 'feature/run_1',
      workspaceRepoRoot: '/tmp/ws',
      createdAt: timestamp
    })
  };
  const facts: CodeHostPullRequestFacts = opts.facts ?? {
    provider: 'github',
    number: 42,
    url: 'https://github.com/example/demo/pull/42',
    state: 'open',
    branch: 'feature/run_1'
  };
  const create = vi.fn().mockImplementation(opts.createBehavior ?? (async () => facts));
  const read = vi.fn().mockImplementation(opts.readBehavior ?? (async () => facts));
  const findByBranch = vi.fn().mockImplementation(opts.findByBranchBehavior ?? (async () => null));
  const codeHostPort: CodeHostPort = {
    create,
    read,
    findByBranch,
    update: vi.fn(),
    merge: vi.fn()
  };
  const codeHosts: CodeHostRegistry = {
    get: vi.fn().mockReturnValue(codeHostPort)
  };
  const eventsAppend = vi.fn().mockResolvedValue(undefined);
  const events: RunEventPublisher = {
    append: eventsAppend,
    replayAfter: vi.fn(),
    subscribe: vi.fn()
  } as unknown as RunEventPublisher;
  const applyDirective = vi.fn(async (input: ApplyOrchestratedDirectiveInput): Promise<OrchestratedRunResult> => ({
    run: makeRun({ currentStep: 'pr.human_review' }),
    runStep: makeRunStep({ id: 'step_next', step: 'pr.human_review', checkpointResult: input.checkpointResult ?? null })
  }));
  const resolveCredential = opts.resolveCredential ?? (async () => ({ token: 'TOKEN_FOR_TEST' }));

  return {
    deps: {
      runs,
      conversations,
      topics,
      projects,
      pullRequests,
      runSteps,
      runWorkspaceMetadata,
      codeHosts,
      resolveCredential,
      events,
      applyDirective,
      clock: () => timestamp
    },
    applyDirective,
    create,
    read,
    findByBranch,
    pullRequestCreate,
    pullRequestUpdateState,
    eventsAppend
  };
}

describe('handlePullRequestOpen', () => {
  it('builds content, calls codeHost.create, persists the PR, and advances to pr.human_review', async () => {
    const { deps, applyDirective, create, pullRequestCreate } = makeDeps();

    const result = await handlePullRequestOpen('run_1', 'tenant_1', deps);

    expect(create).toHaveBeenCalledTimes(1);
    const createInput = create.mock.calls[0]?.[0];
    expect(createInput.target).toEqual({ provider: 'github', owner: 'example', name: 'demo' });
    expect(createInput.branch).toBe('feature/run_1');
    expect(createInput.baseBranch).toBe('main');
    expect(createInput.workspaceRepoRoot).toBe('/tmp/ws');
    expect(createInput.credential.token).toBe('TOKEN_FOR_TEST');
    expect(createInput.content.title).toMatch(/feat:/);

    expect(pullRequestCreate).toHaveBeenCalledTimes(1);
    expect(pullRequestCreate.mock.calls[0]?.[0]).toMatchObject({
      runId: 'run_1',
      tenant: 'tenant_1',
      provider: 'github',
      number: 42,
      url: 'https://github.com/example/demo/pull/42',
      state: 'open',
      branch: 'feature/run_1'
    });

    expect(applyDirective).toHaveBeenCalledTimes(1);
    const directiveInput = applyDirective.mock.calls[0]?.[0] as ApplyOrchestratedDirectiveInput;
    expect(directiveInput.directive).toBe('advance');
    expect(directiveInput.origin).toBe('system');
    const checkpoint = directiveInput.checkpointResult as unknown as PullRequestOpenCheckpoint;
    expect(checkpoint.kind).toBe('pull_request_open');
    expect(checkpoint.number).toBe(42);
    expect(checkpoint.provider).toBe('github');
    expect(checkpoint.url).toBe('https://github.com/example/demo/pull/42');
    expect(checkpoint.branch).toBe('feature/run_1');
    expect(checkpoint.idempotent).toBe(false);

    expect(result.run.currentStep).toBe('pr.human_review');
  });

  it('is idempotent when an open PR already exists — refreshes via codeHost.read, skips create, and emits event', async () => {
    const { deps, applyDirective, create, pullRequestCreate, read, eventsAppend } = makeDeps({
      existingPullRequest: makePullRequest({ number: 99, url: 'https://github.com/example/demo/pull/99' }),
      readBehavior: async () => ({
        provider: 'github',
        number: 99,
        url: 'https://github.com/example/demo/pull/99',
        state: 'open',
        branch: 'feature/run_1'
      })
    });

    await handlePullRequestOpen('run_1', 'tenant_1', deps);

    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]?.[0]).toMatchObject({ number: 99 });
    expect(create).not.toHaveBeenCalled();
    expect(pullRequestCreate).not.toHaveBeenCalled();
    expect(applyDirective).toHaveBeenCalledTimes(1);
    const checkpoint = (applyDirective.mock.calls[0]?.[0] as ApplyOrchestratedDirectiveInput)
      .checkpointResult as unknown as PullRequestOpenCheckpoint;
    expect(checkpoint.idempotent).toBe(true);
    expect(checkpoint.number).toBe(99);
    expect(eventsAppend).toHaveBeenCalledTimes(1);
    const appended = eventsAppend.mock.calls[0]?.[0];
    expect(appended.event.type).toBe('runner_notification');
    expect(appended.event.notification.message).toContain('#99');
  });

  it('fails with pull_request_recovery_pr_not_open when the existing local PR has been merged on the provider', async () => {
    const { deps, pullRequestUpdateState } = makeDeps({
      existingPullRequest: makePullRequest({ number: 99 }),
      readBehavior: async () => ({
        provider: 'github',
        number: 99,
        url: 'https://github.com/example/demo/pull/99',
        state: 'merged',
        branch: 'feature/run_1'
      })
    });
    await expect(handlePullRequestOpen('run_1', 'tenant_1', deps)).rejects.toMatchObject({
      code: 'pull_request_recovery_pr_not_open'
    });
    expect(pullRequestUpdateState).toHaveBeenCalledTimes(1);
    expect(pullRequestUpdateState.mock.calls[0]?.[0]).toMatchObject({ state: 'merged' });
  });

  it('throws missing_code_host_setting when project has no codeHostSetting', async () => {
    const { deps, create } = makeDeps({ projectOverrides: { codeHostSetting: null } });

    await expect(handlePullRequestOpen('run_1', 'tenant_1', deps)).rejects.toMatchObject({
      name: 'PullRequestOpenHandlerError',
      code: 'missing_code_host_setting'
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('throws missing_credential when credential resolution fails (and does not leak any cause message)', async () => {
    const { deps, create } = makeDeps({
      resolveCredential: async () => { throw new Error('upstream failure with sensitive context'); }
    });

    await expect(handlePullRequestOpen('run_1', 'tenant_1', deps)).rejects.toMatchObject({
      name: 'PullRequestOpenHandlerError',
      code: 'missing_credential'
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('maps code-host create failures to code_host_error and does not persist a PR record', async () => {
    const { deps, pullRequestCreate, applyDirective } = makeDeps({
      createBehavior: async () => {
        throw new CodeHostError('provider_unavailable', 'GitHub returned 503.', { provider: 'github' });
      }
    });

    let caught: unknown;
    try {
      await handlePullRequestOpen('run_1', 'tenant_1', deps);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PullRequestOpenHandlerError);
    expect((caught as PullRequestOpenHandlerError).code).toBe('code_host_error');
    expect((caught as PullRequestOpenHandlerError).details).toMatchObject({ code: 'provider_unavailable' });
    expect(pullRequestCreate).not.toHaveBeenCalled();
    expect(applyDirective).not.toHaveBeenCalled();
  });

  it('throws missing_pr_finalize_checkpoint when no pr.finalize step is present', async () => {
    const { deps } = makeDeps({
      runSteps: [
        makeRunStep({ id: 'step_build', step: 'implementation.build', checkpointResult: cumulativeSummaryCheckpoint as unknown as RunStep['checkpointResult'] })
      ]
    });

    await expect(handlePullRequestOpen('run_1', 'tenant_1', deps)).rejects.toMatchObject({
      code: 'missing_pr_finalize_checkpoint'
    });
  });

  it('throws missing_implementation_summary when no cumulative summary exists', async () => {
    const { deps } = makeDeps({
      runSteps: [
        makeRunStep({ id: 'step_fin', step: 'pr.finalize', checkpointResult: finalizeCheckpoint as unknown as RunStep['checkpointResult'] })
      ]
    });

    await expect(handlePullRequestOpen('run_1', 'tenant_1', deps)).rejects.toMatchObject({
      code: 'missing_implementation_summary'
    });
  });

  it('throws invalid_step if the run is not at pr.open', async () => {
    const { deps } = makeDeps({ run: makeRun({ currentStep: 'pr.finalize' }) });
    await expect(handlePullRequestOpen('run_1', 'tenant_1', deps)).rejects.toMatchObject({
      code: 'invalid_step'
    });
  });

  it('emits a runner_notification event after a normal create with only safe PR fields', async () => {
    const { deps, eventsAppend } = makeDeps();
    await handlePullRequestOpen('run_1', 'tenant_1', deps);
    expect(eventsAppend).toHaveBeenCalledTimes(1);
    const call = eventsAppend.mock.calls[0]?.[0];
    expect(call.scope).toEqual({ runId: 'run_1', tenant: 'tenant_1' });
    expect(call.event.type).toBe('runner_notification');
    expect(call.event.step).toBe('pr.open');
    expect(call.event.importance).toBe('normal');
    expect(call.event.notification.severity).toBe('info');
    expect(call.event.notification.message).toContain('#42');
    expect(call.event.notification.message).toContain('https://github.com/example/demo/pull/42');
    // Safety: must not leak token/workspace paths/credentials.
    const serialized = JSON.stringify(call.event);
    expect(serialized).not.toContain('TOKEN_FOR_TEST');
    expect(serialized).not.toContain('/tmp/ws');
  });

  describe('findByBranch recovery (before create)', () => {
    it('reuses an open PR found on the provider and skips codeHost.create', async () => {
      const { deps, create, pullRequestCreate, applyDirective, findByBranch } = makeDeps({
        findByBranchBehavior: async () => ({
          provider: 'github',
          number: 77,
          url: 'https://github.com/example/demo/pull/77',
          state: 'open',
          branch: 'feature/run_1'
        })
      });
      await handlePullRequestOpen('run_1', 'tenant_1', deps);
      expect(findByBranch).toHaveBeenCalledTimes(1);
      expect(create).not.toHaveBeenCalled();
      expect(pullRequestCreate).toHaveBeenCalledTimes(1);
      expect(pullRequestCreate.mock.calls[0]?.[0]).toMatchObject({ number: 77 });
      expect(applyDirective).toHaveBeenCalledTimes(1);
      const checkpoint = (applyDirective.mock.calls[0]?.[0] as ApplyOrchestratedDirectiveInput)
        .checkpointResult as unknown as PullRequestOpenCheckpoint;
      expect(checkpoint.number).toBe(77);
      expect(checkpoint.idempotent).toBe(false);
    });

    it('fails with pull_request_recovery_pr_not_open when findByBranch returns a merged PR', async () => {
      const { deps, create, pullRequestCreate } = makeDeps({
        findByBranchBehavior: async () => ({
          provider: 'github',
          number: 77,
          url: 'https://github.com/example/demo/pull/77',
          state: 'merged',
          branch: 'feature/run_1'
        })
      });
      await expect(handlePullRequestOpen('run_1', 'tenant_1', deps)).rejects.toMatchObject({
        code: 'pull_request_recovery_pr_not_open'
      });
      expect(create).not.toHaveBeenCalled();
      expect(pullRequestCreate).not.toHaveBeenCalled();
    });

    it('fails with pull_request_recovery_pr_not_open when findByBranch returns a closed PR', async () => {
      const { deps, create, pullRequestCreate } = makeDeps({
        findByBranchBehavior: async () => ({
          provider: 'github',
          number: 77,
          url: 'https://github.com/example/demo/pull/77',
          state: 'closed',
          branch: 'feature/run_1'
        })
      });
      await expect(handlePullRequestOpen('run_1', 'tenant_1', deps)).rejects.toMatchObject({
        code: 'pull_request_recovery_pr_not_open'
      });
      expect(create).not.toHaveBeenCalled();
      expect(pullRequestCreate).not.toHaveBeenCalled();
    });

    it('fails with pull_request_recovery_ambiguous_branch_match when findByBranch throws ambiguous_branch_match', async () => {
      const { deps, create } = makeDeps({
        findByBranchBehavior: async () => {
          throw new CodeHostError('ambiguous_branch_match', 'Multiple matches.', { branch: 'feature/run_1' });
        }
      });
      await expect(handlePullRequestOpen('run_1', 'tenant_1', deps)).rejects.toMatchObject({
        code: 'pull_request_recovery_ambiguous_branch_match'
      });
      expect(create).not.toHaveBeenCalled();
    });
  });

  describe('post-create recovery', () => {
    it('persists the PR after persistence throws, when findByBranch then finds an open PR', async () => {
      let calls = 0;
      const { deps, applyDirective, pullRequestCreate, findByBranch } = makeDeps({
        pullRequestCreateBehavior: async () => {
          calls += 1;
          if (calls === 1) throw new Error('transient db error');
          return makePullRequest({ number: 42 });
        },
        findByBranchBehavior: (() => {
          let n = 0;
          return async () => {
            n += 1;
            // First call (before create) returns null; second (recovery) returns open facts.
            if (n === 1) return null;
            return {
              provider: 'github',
              number: 42,
              url: 'https://github.com/example/demo/pull/42',
              state: 'open',
              branch: 'feature/run_1'
            };
          };
        })()
      });
      await handlePullRequestOpen('run_1', 'tenant_1', deps);
      expect(findByBranch).toHaveBeenCalledTimes(2);
      expect(pullRequestCreate).toHaveBeenCalledTimes(2);
      expect(applyDirective).toHaveBeenCalledTimes(1);
    });

    it('fails with pull_request_recovery_missing_provider_match when persistence throws and findByBranch returns null', async () => {
      const { deps, applyDirective } = makeDeps({
        pullRequestCreateBehavior: async () => { throw new Error('transient db error'); },
        findByBranchBehavior: async () => null
      });
      await expect(handlePullRequestOpen('run_1', 'tenant_1', deps)).rejects.toMatchObject({
        code: 'pull_request_recovery_missing_provider_match'
      });
      expect(applyDirective).not.toHaveBeenCalled();
    });

    it('persists and advances when create throws a non-CodeHostError and findByBranch finds an open PR', async () => {
      const { deps, applyDirective, pullRequestCreate, findByBranch } = makeDeps({
        createBehavior: async () => { throw new Error('socket hangup'); },
        findByBranchBehavior: (() => {
          let n = 0;
          return async () => {
            n += 1;
            if (n === 1) return null;
            return {
              provider: 'github',
              number: 55,
              url: 'https://github.com/example/demo/pull/55',
              state: 'open',
              branch: 'feature/run_1'
            };
          };
        })()
      });
      await handlePullRequestOpen('run_1', 'tenant_1', deps);
      expect(findByBranch).toHaveBeenCalledTimes(2);
      expect(pullRequestCreate).toHaveBeenCalledTimes(1);
      expect(pullRequestCreate.mock.calls[0]?.[0]).toMatchObject({ number: 55 });
      expect(applyDirective).toHaveBeenCalledTimes(1);
    });

    it('fails with pull_request_recovery_unknown_create_outcome when create throws non-CodeHostError and findByBranch returns null', async () => {
      const { deps, applyDirective } = makeDeps({
        createBehavior: async () => { throw new Error('socket hangup'); },
        findByBranchBehavior: async () => null
      });
      await expect(handlePullRequestOpen('run_1', 'tenant_1', deps)).rejects.toMatchObject({
        code: 'pull_request_recovery_unknown_create_outcome'
      });
      expect(applyDirective).not.toHaveBeenCalled();
    });
  });
});
