import { describe, expect, it, vi } from 'vitest';

import {
  DefaultOrchestrator,
  InMemoryRunEventBus,
  RunDispatchQueue,
  createCodeHostRegistry,
  defaultReviewerWorkspacePolicy,
  hardcodedDevelopmentPrincipal,
  type CodeHostCredential,
  type ConvergenceEngine,
  type PullRequestOpenWiringDependencies,
  type RunUnitOfWork,
  type SpecFreezeDependencies
} from '@autocatalyst/core';
import type { ConvergenceCheckpoint } from '@autocatalyst/api-contract';
import {
  createDrizzleDomainRepositories,
  createSqliteDatabase,
  migrateSqliteDatabase
} from '@autocatalyst/persistence';
import {
  createGitHubCodeHostAdapter,
  type ExecuteGhFunction
} from '@autocatalyst/github-code-host-adapter';
import type { GhExecInput, GhExecResult } from '@autocatalyst/github-issue-tracker-adapter';

// ---------------------------------------------------------------------------
// Test fixtures shared across the suites
// ---------------------------------------------------------------------------

const owner = {
  id: 'principal_dev_human',
  kind: 'human' as const,
  tenantId: 'tenant_dev',
  displayName: 'Development Principal'
};

const TEST_TOKEN = 'ghp_TEST_TOKEN_123';
const REPO_OWNER = 'testorg';
const REPO_NAME = 'testrepo';
const REPO_SLUG = `${REPO_OWNER}/${REPO_NAME}`;
const PR_NUMBER = 73;
const PR_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}/pull/${PR_NUMBER}`;

// ---------------------------------------------------------------------------
// Fake gh adapter — in-memory provider state, no real subprocess
// ---------------------------------------------------------------------------

interface FakeGhState {
  prState: 'OPEN' | 'MERGED' | 'CLOSED';
  mergedAt: string | null;
  branch: string;
  createdPr: boolean;
}

interface FakeGhHandle {
  readonly executeGh: ExecuteGhFunction;
  readonly state: FakeGhState;
  readonly calls: { args: readonly string[]; token: string }[];
  setMerged(): void;
}

function makeFakeGh(initial: { branch: string }): FakeGhHandle {
  const state: FakeGhState = {
    prState: 'OPEN',
    mergedAt: null,
    branch: initial.branch,
    createdPr: false
  };
  const calls: { args: readonly string[]; token: string }[] = [];

  const buildPrJson = (): string =>
    JSON.stringify({
      number: PR_NUMBER,
      url: PR_URL,
      state: state.prState,
      headRefName: state.branch,
      mergedAt: state.mergedAt
    });

  const executeGh: ExecuteGhFunction = async (input: GhExecInput): Promise<GhExecResult> => {
    calls.push({ args: input.args, token: input.token });
    const args = input.args;
    const verb = args[0];
    const action = args[1];
    if (verb !== 'pr') {
      return { stdout: '{}', truncated: false };
    }
    if (action === 'create') {
      state.createdPr = true;
      state.prState = 'OPEN';
      state.mergedAt = null;
      return { stdout: PR_URL, truncated: false };
    }
    if (action === 'view') {
      return { stdout: buildPrJson(), truncated: false };
    }
    if (action === 'list') {
      // findByBranch — return empty unless a PR has been created
      if (!state.createdPr) {
        return { stdout: '[]', truncated: false };
      }
      return { stdout: `[${buildPrJson()}]`, truncated: false };
    }
    if (action === 'merge') {
      state.prState = 'MERGED';
      state.mergedAt = '2026-06-17T00:00:00.000Z';
      return { stdout: '', truncated: false };
    }
    if (action === 'edit') {
      return { stdout: '', truncated: false };
    }
    return { stdout: '{}', truncated: false };
  };

  return {
    executeGh,
    state,
    calls,
    setMerged(): void {
      state.prState = 'MERGED';
      state.mergedAt = '2026-06-17T00:00:00.000Z';
    }
  };
}

// ---------------------------------------------------------------------------
// Mock spec-freeze dependencies — no real git, no real filesystem
// ---------------------------------------------------------------------------

function makeSpecFreezeDeps(opts: {
  artifactPath: string;
}): SpecFreezeDependencies {
  const artifact = {
    id: 'art_freeze_1',
    runId: 'placeholder',
    owner,
    tenant: 'tenant_dev',
    kind: 'feature_spec' as const,
    canonicalRecord: 'file' as const,
    location: opts.artifactPath,
    cachedStatus: 'approved' as const,
    publicationRefs: [],
    createdAt: '2026-06-17T00:00:00.000Z',
    updatedAt: '2026-06-17T00:00:00.000Z'
  };
  const specFileContents = [
    '---',
    'created: 2026-06-10',
    'last_updated: 2026-06-11',
    'status: approved',
    'specced_by: autocatalyst',
    '---',
    '# Feature Spec',
    '',
    'Spec body.',
    ''
  ].join('\n');

  return {
    artifacts: {
      create: vi.fn(),
      findById: vi.fn(),
      listByRun: vi.fn(),
      findByRunAndKind: vi.fn().mockResolvedValue(artifact),
      updateCachedStatus: vi.fn().mockResolvedValue({ ...artifact, cachedStatus: 'published' as const })
    } as unknown as SpecFreezeDependencies['artifacts'],
    filesystem: {
      writeFile: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockResolvedValue(specFileContents)
    },
    git: {
      reviewerPolicy: defaultReviewerWorkspacePolicy,
      commitFiles: vi.fn().mockResolvedValue({
        commitSha: 'abc1234567890123456789012345678901234567',
        changedFileCount: 1,
        changedFilePaths: [opts.artifactPath]
      }),
      listFilesAtRef: vi.fn().mockResolvedValue([]),
      readFileAtRef: vi.fn().mockResolvedValue(null),
      captureCheckpointRef: vi.fn().mockResolvedValue({
        ref: 'refs/autocatalyst/checkpoints/test',
        commitSha: 'abc1234567890123456789012345678901234567'
      })
    },
    clock: () => '2026-06-17T00:00:00.000Z'
  };
}

// ---------------------------------------------------------------------------
// Polling helper
// ---------------------------------------------------------------------------

async function waitFor<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 5000,
  label = 'condition'
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (predicate(last)) return last;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}. Last: ${JSON.stringify(last)}`);
}

// ---------------------------------------------------------------------------
// Setup helper — provisions a full orchestrator + control plane with all PR deps
// ---------------------------------------------------------------------------

interface LifecycleHarness {
  readonly database: ReturnType<typeof createSqliteDatabase>;
  readonly domainRepos: ReturnType<typeof createDrizzleDomainRepositories>;
  readonly orchestrator: DefaultOrchestrator;
  readonly fakeGh: FakeGhHandle;
  readonly project: { id: string };
  readonly run: { id: string };
  readonly branch: string;
}

async function setupLifecycle(opts: {
  unitOfWork: RunUnitOfWork;
}): Promise<LifecycleHarness> {
  const now = '2026-06-17T00:00:00.000Z';
  const database = createSqliteDatabase({ path: ':memory:' });
  await migrateSqliteDatabase(database);
  const domainRepos = createDrizzleDomainRepositories(database);

  // 1. Project with code-host setting bound to a credentialRef
  const project = await domainRepos.projects.create({
    owner,
    tenant: 'tenant_dev',
    displayName: 'PR Lifecycle Integration Project',
    repoUrl: `https://github.com/${REPO_SLUG}`,
    hostRepository: { provider: 'github', owner: REPO_OWNER, name: REPO_NAME, url: `https://github.com/${REPO_SLUG}` },
    workspaceRootOverride: null,
    issueTrackerSetting: null,
    codeHostSetting: { provider: 'github', credentialRef: { id: 'cred_1', purpose: 'code_host' } },
    credentialRefs: []
  });

  // 2. Seed the run directly at implementation.human_review using the ingress.
  // We will manually insert prior step records (notably implementation.build)
  // with the cumulative summary checkpoint so the pr.open handler can find it.
  const seed = await new (await import('@autocatalyst/persistence')).DrizzleConversationIngressRepository(database)
    .createConversationTopicMessageAndRun({
      conversation: {
        projectId: project.id,
        owner,
        tenant: 'tenant_dev',
        identity: 'pr-lifecycle-test',
        activeTopicId: null
      },
      topic: {
        owner,
        tenant: 'tenant_dev',
        title: 'PR Lifecycle Topic',
        kind: 'main'
      },
      message: {
        owner,
        tenant: 'tenant_dev',
        author: owner,
        direction: 'inbound',
        body: 'drive a PR lifecycle'
      },
      run: {
        owner,
        tenant: 'tenant_dev',
        workKind: 'feature',
        currentStep: 'implementation.human_review',
        terminal: false
      },
      runStep: {
        phase: 'implementation',
        step: 'implementation.human_review',
        role: 'none',
        startedAt: now,
        endedAt: null,
        durationMs: null
      }
    });

  const runId = seed.run.id;
  const branch = `feature/${runId.slice(0, 8)}`;

  // 3. Insert a prior implementation.build run step carrying the cumulative summary
  const buildStep = await domainRepos.runSteps.create({
    runId,
    phase: 'implementation',
    step: 'implementation.build',
    role: 'none',
    startedAt: now,
    endedAt: now,
    durationMs: 1000,
    occurrence: { index: 0, attempt: 1 }
  });
  const cumulativeSummary = {
    kind: 'cumulative_implementation_summary' as const,
    cumulativeSummary: 'Added new auth module with JWT support.',
    changedFiles: ['src/auth.ts', 'src/auth.spec.ts'],
    validationSummary: ['All tests pass'],
    followUps: [],
    nonGoals: [],
    sourceRoundCount: 2,
    completedAt: now
  };
  await domainRepos.runSteps.updateCheckpoint({
    runStepId: buildStep.id,
    runId,
    tenant: 'tenant_dev',
    checkpointResult: cumulativeSummary as unknown as Parameters<typeof domainRepos.runSteps.updateCheckpoint>[0]['checkpointResult']
  });

  // 4. Insert workspace metadata so the pr.open handler can find the repo root and branch
  await domainRepos.runWorkspaceMetadata.upsert({
    runId,
    workspaceHandle: branch,
    workspaceRepoRoot: '/tmp/fake-workspace',
    createdAt: now
  });

  // 5. Wire the github code-host adapter with a fake gh executor (no real subprocess)
  const fakeGh = makeFakeGh({ branch });
  const adapter = createGitHubCodeHostAdapter({
    executeGh: fakeGh.executeGh,
    git: { pushBranch: vi.fn().mockResolvedValue(undefined) }
  });
  const codeHosts = createCodeHostRegistry([
    { provider: 'github', create: () => adapter }
  ]);
  const resolveCredential = async (_ref: unknown): Promise<CodeHostCredential> => ({ token: TEST_TOKEN });

  const pullRequestOpenDependencies: PullRequestOpenWiringDependencies = {
    conversations: domainRepos.conversations,
    topics: domainRepos.topics,
    projects: domainRepos.projects,
    pullRequests: domainRepos.pullRequests,
    codeHosts,
    resolveCredential
  };

  const specFreezeDependencies = makeSpecFreezeDeps({
    artifactPath: 'context-human/specs/feature-pr-lifecycle.md'
  });

  const eventBus = new InMemoryRunEventBus();
  const dispatchQueue = new RunDispatchQueue({ maxConcurrent: 2 });
  const orchestrator = new DefaultOrchestrator({
    runs: domainRepos.runs,
    conversationIngress: new (await import('@autocatalyst/persistence')).DrizzleConversationIngressRepository(database),
    events: eventBus,
    dispatchQueue,
    unitOfWork: opts.unitOfWork,
    autoDispatch: { enabled: true },
    runSteps: domainRepos.runSteps,
    runWorkspaceMetadata: domainRepos.runWorkspaceMetadata,
    specFreezeDependencies,
    pullRequestOpenDependencies,
    feedbackLifecycleDependencies: {
      feedback: domainRepos.feedback,
      ids: () => `fb_${Math.random().toString(36).slice(2)}`,
      clock: () => now
    },
    resolveWorkspaceContext: async () => ({
      workspaceRepoRoot: '/tmp/fake-workspace',
      workspaceHandle: branch
    }),
    clock: () => now
  });

  return {
    database,
    domainRepos,
    orchestrator,
    fakeGh,
    project: { id: project.id },
    run: { id: runId },
    branch
  };
}

// ---------------------------------------------------------------------------
// pr.finalize result fixtures
// ---------------------------------------------------------------------------

const prFinalizeAdvanceResult = {
  directive: 'advance' as const,
  reconciledSummary: 'Adds JWT-based authentication.',
  titleSubject: 'add JWT authentication',
  validationSummary: ['All tests pass'],
  findings: [] as Array<{ severity: 'blocker' | 'warning' | 'info'; summary: string; target?: string }>
};

const prFinalizeReviseResult = {
  directive: 'revise' as const,
  validationSummary: [] as string[],
  findings: [
    {
      severity: 'blocker' as const,
      summary: 'The auth module does not handle expired tokens.',
      target: 'implementation'
    }
  ]
};

// ---------------------------------------------------------------------------
// Test 1 — happy path
// ---------------------------------------------------------------------------

describe('PR lifecycle integration: happy path', () => {
  it(
    'advances through pr.finalize → spec freeze → pr.open → pr.human_review → detectMerges → done',
    async () => {
      const unitOfWork: RunUnitOfWork = {
        run: async ({ run }) => {
          if (run.currentStep === 'pr.finalize') {
            return { directive: 'advance', result: prFinalizeAdvanceResult };
          }
          return { directive: 'advance' };
        }
      };

      const harness = await setupLifecycle({ unitOfWork });
      try {
        const { orchestrator, domainRepos, fakeGh, run: runRef, branch } = harness;

        // Manually advance implementation.human_review (human gate) with origin='human'
        await orchestrator.applyDirective({
          runId: runRef.id,
          directive: 'advance',
          tenant: 'tenant_dev',
          origin: 'human',
          principal: hardcodedDevelopmentPrincipal
        });

        // Auto-dispatch will then drive: pr.finalize (AI step) → spec freeze → pr.open
        // (system step) → pr.human_review (human, halt). Wait until we reach pr.human_review.
        const haltedRun = await waitFor(
          async () => {
            const r = await domainRepos.runs.findById(runRef.id);
            if (r === null) throw new Error('run missing');
            return r;
          },
          (r) => r.currentStep === 'pr.human_review',
          7000,
          'pr.human_review'
        );
        expect(haltedRun.currentStep).toBe('pr.human_review');
        expect(haltedRun.terminal).toBe(false);

        // The fake gh adapter must have created a PR in the OPEN state.
        const createdPrCall = fakeGh.calls.find((c) => c.args[0] === 'pr' && c.args[1] === 'create');
        expect(createdPrCall).toBeDefined();
        // The title argument should be the conventional title built from the pr.finalize subject.
        const titleIdx = createdPrCall!.args.indexOf('--title');
        expect(titleIdx).toBeGreaterThan(-1);
        const title = createdPrCall!.args[titleIdx + 1];
        expect(title).toBe('feat: add JWT authentication');
        // Body should contain the reconciled summary.
        const bodyIdx = createdPrCall!.args.indexOf('--body');
        const body = createdPrCall!.args[bodyIdx + 1] ?? '';
        expect(body).toContain('Adds JWT-based authentication.');
        // Body should include changed file list.
        expect(body).toContain('src/auth.ts');
        // Repo slug
        expect(createdPrCall!.args.indexOf('--repo')).toBeGreaterThan(-1);
        expect(createdPrCall!.args[createdPrCall!.args.indexOf('--repo') + 1]).toBe(REPO_SLUG);
        // Branch and base
        expect(createdPrCall!.args[createdPrCall!.args.indexOf('--head') + 1]).toBe(branch);
        expect(createdPrCall!.args[createdPrCall!.args.indexOf('--base') + 1]).toBe('main');
        // Token is never leaked into args.
        for (const arg of createdPrCall!.args) {
          expect(arg).not.toContain(TEST_TOKEN);
        }

        // A pull-request record must exist in the open state at this point.
        const openPr = await domainRepos.pullRequests.findByRun(runRef.id);
        expect(openPr).not.toBeNull();
        expect(openPr!.state).toBe('open');
        expect(openPr!.number).toBe(PR_NUMBER);
        expect(openPr!.url).toBe(PR_URL);
        expect(openPr!.provider).toBe('github');

        // Now flip the provider state to MERGED and run detectMerges.
        fakeGh.setMerged();
        const reconciliation = await orchestrator.detectMerges('tenant_dev');
        expect(reconciliation.merged).toBe(1);
        expect(reconciliation.failed).toBe(0);

        // Wait for the run to reach `done` and become terminal.
        const finalRun = await waitFor(
          async () => {
            const r = await domainRepos.runs.findById(runRef.id);
            if (r === null) throw new Error('run missing');
            return r;
          },
          (r) => r.terminal === true,
          5000,
          'terminal run'
        );
        expect(finalRun.currentStep).toBe('done');
        expect(finalRun.terminal).toBe(true);

        // PR record state must be merged.
        const mergedPr = await domainRepos.pullRequests.findByRun(runRef.id);
        expect(mergedPr).not.toBeNull();
        expect(mergedPr!.state).toBe('merged');
      } finally {
        harness.database.close();
      }
    },
    20000
  );
});

// ---------------------------------------------------------------------------
// Test 2 — blocker path
// ---------------------------------------------------------------------------

describe('PR lifecycle integration: blocker path', () => {
  it(
    'routes back to implementation.human_review and records feedback without opening a PR',
    async () => {
      const unitOfWork: RunUnitOfWork = {
        run: async ({ run }) => {
          if (run.currentStep === 'pr.finalize') {
            return { directive: 'advance', result: prFinalizeReviseResult };
          }
          return { directive: 'advance' };
        }
      };

      const harness = await setupLifecycle({ unitOfWork });
      try {
        const { orchestrator, domainRepos, fakeGh, run: runRef } = harness;

        // Advance implementation.human_review with origin='human' → pr.finalize
        await orchestrator.applyDirective({
          runId: runRef.id,
          directive: 'advance',
          tenant: 'tenant_dev',
          origin: 'human',
          principal: hardcodedDevelopmentPrincipal
        });

        // Auto-dispatch fires pr.finalize. The 'revise' parsed directive routes the
        // run back to implementation.human_review and stamps Feedback for the blocker.
        const revisedRun = await waitFor(
          async () => {
            const r = await domainRepos.runs.findById(runRef.id);
            if (r === null) throw new Error('run missing');
            return r;
          },
          (r) => r.currentStep === 'implementation.human_review',
          7000,
          'implementation.human_review (revise loop)'
        );
        expect(revisedRun.currentStep).toBe('implementation.human_review');
        expect(revisedRun.terminal).toBe(false);

        // Feedback record must have been created with target = 'implementation'.
        const feedbackForRun = await domainRepos.feedback.listByRun(runRef.id);
        expect(feedbackForRun.length).toBeGreaterThanOrEqual(1);
        expect(feedbackForRun.some((f) => f.target === 'implementation')).toBe(true);

        // No PR record must exist — the code-host adapter must not have been called for create.
        const prRecord = await domainRepos.pullRequests.findByRun(runRef.id);
        expect(prRecord).toBeNull();
        const createCall = fakeGh.calls.find((c) => c.args[0] === 'pr' && c.args[1] === 'create');
        expect(createCall).toBeUndefined();
      } finally {
        harness.database.close();
      }
    },
    20000
  );
});

// ---------------------------------------------------------------------------
// Test 3 — summary from convergence rounds (proves the real folding path)
// ---------------------------------------------------------------------------

describe('PR lifecycle integration: PR body from convergence-round folding', () => {
  it(
    'builds PR body from implementer disposition summaries through real orchestrator folding, not injected summary',
    async () => {
      const now = '2026-06-17T00:00:00.000Z';
      const database = createSqliteDatabase({ path: ':memory:' });
      await migrateSqliteDatabase(database);
      const domainRepos = createDrizzleDomainRepositories(database);

      const project = await domainRepos.projects.create({
        owner,
        tenant: 'tenant_dev',
        displayName: 'Folding Test Project',
        repoUrl: `https://github.com/${REPO_SLUG}`,
        hostRepository: { provider: 'github', owner: REPO_OWNER, name: REPO_NAME, url: `https://github.com/${REPO_SLUG}` },
        workspaceRootOverride: null,
        issueTrackerSetting: null,
        codeHostSetting: { provider: 'github', credentialRef: { id: 'cred_1', purpose: 'code_host' } },
        credentialRefs: []
      });

      // Run starts at implementation.build — no pre-formed cumulative summary injected.
      // The orchestrator must build the summary from the convergence rounds.
      const seed = await new (await import('@autocatalyst/persistence')).DrizzleConversationIngressRepository(database)
        .createConversationTopicMessageAndRun({
          conversation: {
            projectId: project.id,
            owner,
            tenant: 'tenant_dev',
            identity: 'folding-test',
            activeTopicId: null
          },
          topic: {
            owner,
            tenant: 'tenant_dev',
            title: 'Folding Test Topic',
            kind: 'main'
          },
          message: {
            owner,
            tenant: 'tenant_dev',
            author: owner,
            direction: 'inbound',
            body: 'prove summary folding'
          },
          run: {
            owner,
            tenant: 'tenant_dev',
            workKind: 'feature',
            currentStep: 'implementation.build',
            terminal: false
          },
          runStep: {
            phase: 'implementation',
            step: 'implementation.build',
            role: 'none',
            startedAt: now,
            endedAt: null,
            durationMs: null
          }
        });

      const runId = seed.run.id;
      const branch = `feature/${runId.slice(0, 8)}`;

      await domainRepos.runWorkspaceMetadata.upsert({
        runId,
        workspaceHandle: branch,
        workspaceRepoRoot: '/tmp/fake-workspace',
        createdAt: now
      });

      // The disposition summary is what the implementer wrote — this must appear in the PR body.
      const IMPL_SUMMARY_ROUND1 = 'Added JWT authentication middleware with token refresh';
      const IMPL_SUMMARY_ROUND2 = 'Fixed token expiry edge case in refresh flow';
      const CHANGED_FILES_ROUND1 = 4;
      const CHANGED_FILES_ROUND2 = 2;

      // Mock convergence engine returns two rounds with implementer disposition summaries.
      // The orchestrator's folding logic builds the cumulative summary from these dispositions.
      const convergenceCheckpoint: ConvergenceCheckpoint = {
        kind: 'convergence_review',
        step: 'implementation.build',
        maxRounds: 3,
        routing: { distinct: false },
        rounds: [
          {
            round: 1,
            changedFileCount: CHANGED_FILES_ROUND1,
            findings: [],
            dispositions: [
              { disposition: 'fixed', feedbackId: 'fb_round1', summary: IMPL_SUMMARY_ROUND1 }
            ],
            outcome: 'continue',
            altitude: 'build'
          },
          {
            round: 2,
            changedFileCount: CHANGED_FILES_ROUND2,
            findings: [],
            dispositions: [
              { disposition: 'fixed', feedbackId: 'fb_round2', summary: IMPL_SUMMARY_ROUND2 }
            ],
            outcome: 'converged',
            altitude: 'build'
          }
        ],
        outcome: 'converged',
        openFeedbackIds: [],
        lastPositions: {}
      };

      const mockConvergenceEngine: ConvergenceEngine = {
        run: async () => ({
          workResult: { directive: 'advance' },
          checkpointResult: convergenceCheckpoint
        })
      };

      // pr.finalize returns a clean result without a reconciled summary —
      // the body must be sourced entirely from the folded cumulative summary.
      const unitOfWork: RunUnitOfWork = {
        run: async ({ run: r }) => {
          if (r.currentStep === 'pr.finalize') {
            return {
              directive: 'advance',
              result: {
                directive: 'advance' as const,
                titleSubject: 'add JWT auth middleware',
                validationSummary: [] as string[],
                findings: [] as Array<{ severity: 'blocker' | 'warning' | 'info'; summary: string; target?: string }>
              }
            };
          }
          return { directive: 'advance' };
        }
      };

      const fakeGh = makeFakeGh({ branch });
      const adapter = createGitHubCodeHostAdapter({
        executeGh: fakeGh.executeGh,
        git: { pushBranch: vi.fn().mockResolvedValue(undefined) }
      });
      const codeHosts = createCodeHostRegistry([
        { provider: 'github', create: () => adapter }
      ]);
      const resolveCredential = async (_ref: unknown): Promise<CodeHostCredential> => ({ token: TEST_TOKEN });
      const pullRequestOpenDependencies: PullRequestOpenWiringDependencies = {
        conversations: domainRepos.conversations,
        topics: domainRepos.topics,
        projects: domainRepos.projects,
        pullRequests: domainRepos.pullRequests,
        codeHosts,
        resolveCredential
      };

      const specFreezeDependencies = makeSpecFreezeDeps({
        artifactPath: 'context-human/specs/feature-folding.md'
      });

      const eventBus = new InMemoryRunEventBus();
      const dispatchQueue = new RunDispatchQueue({ maxConcurrent: 2 });
      const orchestrator = new DefaultOrchestrator({
        runs: domainRepos.runs,
        conversationIngress: new (await import('@autocatalyst/persistence')).DrizzleConversationIngressRepository(database),
        events: eventBus,
        dispatchQueue,
        unitOfWork,
        autoDispatch: { enabled: true },
        runSteps: domainRepos.runSteps,
        runWorkspaceMetadata: domainRepos.runWorkspaceMetadata,
        specFreezeDependencies,
        pullRequestOpenDependencies,
        convergenceEngine: mockConvergenceEngine,
        feedbackLifecycleDependencies: {
          feedback: domainRepos.feedback,
          ids: () => `fb_${Math.random().toString(36).slice(2)}`,
          clock: () => now
        },
        resolveWorkspaceContext: async () => ({
          workspaceRepoRoot: '/tmp/fake-workspace',
          workspaceHandle: branch
        }),
        clock: () => now
      });

      try {
        // Dispatch implementation.build — the convergence engine returns rounds with dispositions,
        // and the orchestrator folds them into a cumulative summary before advancing.
        await orchestrator.dispatch({ runId, tenant: 'tenant_dev' });

        // Wait until auto-dispatch moves the run past implementation.build → implementation.human_review
        await waitFor(
          async () => {
            const r = await domainRepos.runs.findById(runId);
            if (r === null) throw new Error('run missing');
            return r;
          },
          (r) => r.currentStep === 'implementation.human_review',
          7000,
          'implementation.human_review after build'
        );

        // Human advances implementation.human_review → pr.finalize → pr.open
        await orchestrator.applyDirective({
          runId,
          directive: 'advance',
          tenant: 'tenant_dev',
          origin: 'human',
          principal: hardcodedDevelopmentPrincipal
        });

        // Wait for pr.open to complete and reach pr.human_review
        await waitFor(
          async () => {
            const r = await domainRepos.runs.findById(runId);
            if (r === null) throw new Error('run missing');
            return r;
          },
          (r) => r.currentStep === 'pr.human_review',
          7000,
          'pr.human_review after folded summary'
        );

        // Assert the PR body contains both round disposition summaries — not reviewer finding titles.
        const createCall = fakeGh.calls.find((c) => c.args[0] === 'pr' && c.args[1] === 'create');
        expect(createCall, 'gh pr create must have been called').toBeDefined();
        const bodyIdx = createCall!.args.indexOf('--body');
        const body = createCall!.args[bodyIdx + 1] ?? '';

        // Both rounds' implementer descriptions must appear in the PR body.
        expect(body).toContain(IMPL_SUMMARY_ROUND1);
        expect(body).toContain(IMPL_SUMMARY_ROUND2);
        // The changed-file entries come from changedFileCount, not reviewer findings.
        expect(body).toContain(`round 1: ${CHANGED_FILES_ROUND1} file(s) changed`);
        expect(body).toContain(`round 2: ${CHANGED_FILES_ROUND2} file(s) changed`);
      } finally {
        database.close();
      }
    },
    25000
  );
});
