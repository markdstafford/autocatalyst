import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRunWorkspaceGitPort } from './run-workspace-git-port.js';

import {
  DefaultControlPlaneService,
  DefaultOrchestrator,
  InMemoryRunEventBus,
  RunDispatchQueue,
  createCodeHostRegistry,
  defaultReviewerWorkspacePolicy,
  hardcodedDevelopmentPrincipal,
  permissivePolicyDecisionPoint,
  registerControlPlaneRoutes,
  type CodeHostCredential,
  type ControlPlaneService,
  type ConvergenceEngine,
  type PullRequestOpenWiringDependencies,
  type RunUnitOfWork,
  type RunWorkspaceGitPort,
  type SpecFreezeDependencies,
  type WorkspaceFileSystemPort
} from '@autocatalyst/core';
import type { ConvergenceCheckpoint, NonModelPrincipal, Principal, PullRequest } from '@autocatalyst/api-contract';
import {
  pullRequestReconciliationPath,
  reconcilePullRequestsSuccessStatusCode,
  runPullRequestRefreshResponseSchema
} from '@autocatalyst/api-contract';
import {
  DrizzleConversationIngressRepository,
  DrizzleConfigurationRecordRepository,
  DrizzleProbeResourceRepository,
  SqliteSecretStore,
  asInternalSqliteDatabase,
  createDrizzleDomainRepositories,
  createSqliteDatabase,
  migrateSqliteDatabase
} from '@autocatalyst/persistence';
import {
  createGitHubCodeHostAdapter,
  type ExecuteGhFunction
} from '@autocatalyst/github-code-host-adapter';
import { GhExecError, type GhExecInput, type GhExecResult } from '@autocatalyst/github-issue-tracker-adapter';
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';

import { createPullRequestReconciliationTicker } from './pr-reconciliation-ticker.js';
import { createControlPlaneServer } from './server.js';

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
const RECONCILE_TEST_BEARER_TOKEN = 'reconcile-test-bearer-token';
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
  setClosed(): void;
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
    },
    setClosed(): void {
      state.prState = 'CLOSED';
      state.mergedAt = null;
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
  runWorkspaceGit?: Pick<RunWorkspaceGitPort, 'getChangedFiles'>;
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
  const seed = await new DrizzleConversationIngressRepository(database)
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
    resolveCredential,
    ...(opts.runWorkspaceGit !== undefined ? { runWorkspaceGit: opts.runWorkspaceGit } : {})
  };

  const specFreezeDependencies = makeSpecFreezeDeps({
    artifactPath: 'context-human/specs/feature-pr-lifecycle.md'
  });

  const eventBus = new InMemoryRunEventBus();
  const dispatchQueue = new RunDispatchQueue({ maxConcurrent: 2 });
  const orchestrator = new DefaultOrchestrator({
    runs: domainRepos.runs,
    conversationIngress: new DrizzleConversationIngressRepository(database),
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
// Test 1b — pr.finalize {} recovery
// ---------------------------------------------------------------------------

describe('PR lifecycle integration: pr.finalize {} recovery', () => {
  it(
    'recovers from empty {} pr.finalize result and advances toward pr.open',
    async () => {
      const unitOfWork: RunUnitOfWork = {
        run: async ({ run }) => {
          if (run.currentStep === 'pr.finalize') {
            // {} means "no blockers" — should normalize to { directive: 'advance', findings: [] }
            return { directive: 'advance', result: {} };
          }
          return { directive: 'advance' };
        }
      };

      const harness = await setupLifecycle({ unitOfWork });
      try {
        const { orchestrator, domainRepos, run: runRef } = harness;

        await orchestrator.applyDirective({
          runId: runRef.id,
          directive: 'advance',
          tenant: 'tenant_dev',
          origin: 'human',
          principal: hardcodedDevelopmentPrincipal
        });

        // Should advance past pr.finalize without pr_finalize_invalid_result
        const haltedRun = await waitFor(
          async () => {
            const r = await domainRepos.runs.findById(runRef.id);
            if (r === null) throw new Error('run missing');
            return r;
          },
          (r) => r.currentStep === 'pr.human_review' || r.terminal === true,
          7000,
          'pr.human_review or terminal'
        );

        // Must not have failed with pr_finalize_invalid_result
        expect(haltedRun.terminal).toBe(false);
        expect(haltedRun.currentStep).toBe('pr.human_review');
        expect((haltedRun as { failureReason?: string }).failureReason).toBeUndefined();

        // The pr.finalize checkpoint should contain the validated clean advance result
        const runSteps = await domainRepos.runSteps.listByRun(runRef.id);
        const prFinalizeStep = runSteps.find((s) => s.step === 'pr.finalize');
        expect(prFinalizeStep).toBeDefined();
        if (prFinalizeStep?.checkpointResult !== null && prFinalizeStep?.checkpointResult !== undefined) {
          const checkpoint = prFinalizeStep.checkpointResult as { directive?: string; findings?: unknown[] };
          expect(checkpoint.directive).toBe('advance');
          expect(checkpoint.findings).toEqual([]);
        }
      } finally {
        harness.database.close();
      }
    },
    10000
  );
});

// ---------------------------------------------------------------------------
// Test 1c — sparse {} finalize with real git-port paths
// ---------------------------------------------------------------------------

const SPARSE_FINALIZE_PATHS = [
  'packages/core/src/pr-content.ts',
  'packages/core/src/pr-open-handler.ts'
] as const;

describe('PR lifecycle integration: sparse {} finalize opens PR with real content', () => {
  it(
    'opens a PR with a conventional title and real file paths from getChangedFiles when pr.finalize returns {}',
    async () => {
      const fakeRunWorkspaceGit: Pick<RunWorkspaceGitPort, 'getChangedFiles'> = {
        getChangedFiles: vi.fn().mockResolvedValue([
          { path: SPARSE_FINALIZE_PATHS[0], status: 'modified' },
          { path: SPARSE_FINALIZE_PATHS[1], status: 'modified' }
        ])
      };

      const unitOfWork: RunUnitOfWork = {
        run: async ({ run }) => {
          if (run.currentStep === 'pr.finalize') {
            // Sparse {} — no title, no summary, no findings.
            return { directive: 'advance', result: {} };
          }
          return { directive: 'advance' };
        }
      };

      const harness = await setupLifecycle({ unitOfWork, runWorkspaceGit: fakeRunWorkspaceGit });
      try {
        const { orchestrator, domainRepos, fakeGh, run: runRef } = harness;

        await orchestrator.applyDirective({
          runId: runRef.id,
          directive: 'advance',
          tenant: 'tenant_dev',
          origin: 'human',
          principal: hardcodedDevelopmentPrincipal
        });

        const haltedRun = await waitFor(
          async () => {
            const r = await domainRepos.runs.findById(runRef.id);
            if (r === null) throw new Error('run missing');
            return r;
          },
          (r) => r.currentStep === 'pr.human_review' || r.terminal === true,
          7000,
          'pr.human_review or terminal'
        );

        expect(haltedRun.terminal).toBe(false);
        expect(haltedRun.currentStep).toBe('pr.human_review');

        const createCall = fakeGh.calls.find((c) => c.args[0] === 'pr' && c.args[1] === 'create');
        expect(createCall, 'gh pr create must have been called').toBeDefined();

        const titleIdx = createCall!.args.indexOf('--title');
        const title = createCall!.args[titleIdx + 1] ?? '';

        // Title must be a conventional commit title derived from changed paths — not a placeholder.
        expect(title).toMatch(/^feat: /u);
        expect(title).not.toMatch(/round \d+/iu);
        expect(title).not.toContain('implementation passed review');
        expect(title).not.toContain('file(s) changed');

        const bodyIdx = createCall!.args.indexOf('--body');
        const body = createCall!.args[bodyIdx + 1] ?? '';

        // Body must include the real git-port paths.
        expect(body).toContain(`- \`${SPARSE_FINALIZE_PATHS[0]}\``);
        expect(body).toContain(`- \`${SPARSE_FINALIZE_PATHS[1]}\``);

        // Body must not contain legacy placeholder text.
        expect(body).not.toMatch(/round \d+/iu);
        expect(body).not.toContain('implementation passed review');
        expect(body).not.toContain('file(s) changed');
      } finally {
        harness.database.close();
      }
    },
    15000
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
      const seed = await new DrizzleConversationIngressRepository(database)
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
      const CHANGED_FILES_ROUND1 = [
        'packages/core/src/auth.ts',
        'packages/core/src/auth.spec.ts',
        'packages/core/src/jwt.ts',
        'packages/core/src/jwt.spec.ts'
      ];
      const CHANGED_FILES_ROUND2 = [
        'packages/core/src/auth.ts',
        'packages/core/src/token-expiry.ts'
      ];

      // Mock convergence engine returns two rounds with implementer disposition summaries
      // and real changed file paths. The orchestrator folds them into a cumulative summary.
      const convergenceCheckpoint: ConvergenceCheckpoint = {
        kind: 'convergence_review',
        step: 'implementation.build',
        maxRounds: 3,
        routing: { distinct: false },
        rounds: [
          {
            round: 1,
            changedFileCount: CHANGED_FILES_ROUND1.length,
            changedFilePaths: CHANGED_FILES_ROUND1,
            findings: [],
            dispositions: [
              { disposition: 'fixed', feedbackId: 'fb_round1', summary: IMPL_SUMMARY_ROUND1 }
            ],
            outcome: 'continue',
            altitude: 'build'
          },
          {
            round: 2,
            changedFileCount: CHANGED_FILES_ROUND2.length,
            changedFilePaths: CHANGED_FILES_ROUND2,
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
        conversationIngress: new DrizzleConversationIngressRepository(database),
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
        // Changed files must appear as real repository-relative paths, not count placeholders.
        expect(body).toContain('packages/core/src/auth.ts');
        expect(body).toContain('packages/core/src/jwt.ts');
        expect(body).toContain('packages/core/src/token-expiry.ts');
        // Placeholder strings must not appear.
        expect(body).not.toMatch(/round \d+: \d+ file\(s\) changed/u);
        expect(body).not.toContain('implementation passed review');
      } finally {
        database.close();
      }
    },
    25000
  );
});

// ---------------------------------------------------------------------------
// Test 4 — real git port with real temp repo (proves production wiring)
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

async function initGitRepo(dir: string): Promise<void> {
  await execFileAsync('git', ['init'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: dir });
}

describe('PR lifecycle integration: real git port proves production wiring', () => {
  it(
    'opens a PR whose body contains file paths from a real git diff (no mocks for getChangedFiles)',
    async () => {
      // Step 1: create a real temporary git repo
      const realRepoDir = await mkdtemp(join(tmpdir(), 'ac-pr-lifecycle-real-git-'));
      try {
        await initGitRepo(realRepoDir);

        // Step 2: make a base commit so we have a parent to diff against
        await writeFile(join(realRepoDir, 'README.md'), '# base\n');
        await execFileAsync('git', ['add', '--all'], { cwd: realRepoDir });
        await execFileAsync('git', ['commit', '-m', 'base commit'], { cwd: realRepoDir });
        const { stdout: baseShaRaw } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: realRepoDir });
        const baseSha = baseShaRaw.trim();

        // Step 3: add real files that should appear in the PR body
        const REAL_FILES = [
          'packages/auth/src/login.ts',
          'packages/auth/src/logout.ts'
        ];
        await execFileAsync('git', ['config', 'core.protectNTFS', 'false'], { cwd: realRepoDir }).catch(() => undefined);
        // Create nested directories and files
        const { mkdir } = await import('node:fs/promises');
        await mkdir(join(realRepoDir, 'packages', 'auth', 'src'), { recursive: true });
        await writeFile(join(realRepoDir, 'packages', 'auth', 'src', 'login.ts'), 'export function login() {}\n');
        await writeFile(join(realRepoDir, 'packages', 'auth', 'src', 'logout.ts'), 'export function logout() {}\n');
        await execFileAsync('git', ['add', '--all'], { cwd: realRepoDir });
        await execFileAsync('git', ['commit', '-m', 'add auth module'], { cwd: realRepoDir });

        // Step 4: use the real port
        const realPort = createRunWorkspaceGitPort({ workspacesRoot: tmpdir() });

        // Step 5 & 6: set up the harness with real port, real workspaceRepoRoot, and provisionedBaseRef
        const unitOfWork: RunUnitOfWork = {
          run: async ({ run: r }) => {
            if (r.currentStep === 'pr.finalize') {
              // Sparse {} — no title, no summary, no findings.
              return { directive: 'advance', result: {} };
            }
            return { directive: 'advance' };
          }
        };

        const harness = await setupLifecycle({ unitOfWork, runWorkspaceGit: realPort });

        // Override the workspace metadata to point at the real repo and real base SHA
        const { domainRepos, run: runRef, branch } = harness;
        const now = '2026-06-17T00:00:00.000Z';
        await domainRepos.runWorkspaceMetadata.upsert({
          runId: runRef.id,
          workspaceHandle: branch,
          workspaceRepoRoot: realRepoDir,
          provisionedBaseRef: baseSha,
          createdAt: now
        });

        try {
          const { orchestrator, fakeGh } = harness;

          // Step 7: run the PR lifecycle with sparse {} pr.finalize
          await orchestrator.applyDirective({
            runId: runRef.id,
            directive: 'advance',
            tenant: 'tenant_dev',
            origin: 'human',
            principal: hardcodedDevelopmentPrincipal
          });

          await waitFor(
            async () => {
              const r = await domainRepos.runs.findById(runRef.id);
              if (r === null) throw new Error('run missing');
              return r;
            },
            (r) => r.currentStep === 'pr.human_review' || r.terminal === true,
            10000,
            'pr.human_review or terminal'
          );

          // Step 8 & 9: assert that real git diff paths appear in PR body
          const createCall = fakeGh.calls.find((c) => c.args[0] === 'pr' && c.args[1] === 'create');
          expect(createCall, 'gh pr create must have been called').toBeDefined();

          const titleIdx = createCall!.args.indexOf('--title');
          const title = createCall!.args[titleIdx + 1] ?? '';

          // Title must be a conventional commit title — not a placeholder.
          expect(title).toMatch(/^feat: /u);
          expect(title).not.toMatch(/round \d+/iu);
          expect(title).not.toContain('implementation passed review');
          expect(title).not.toContain('file(s) changed');

          const bodyIdx = createCall!.args.indexOf('--body');
          const body = createCall!.args[bodyIdx + 1] ?? '';

          // Body must contain the EXACT paths from the real git diff.
          expect(body).toContain(`- \`${REAL_FILES[0]}\``);
          expect(body).toContain(`- \`${REAL_FILES[1]}\``);

          // Body must not contain placeholder text.
          expect(body).not.toMatch(/round \d+/iu);
          expect(body).not.toContain('implementation passed review');
          expect(body).not.toContain('file(s) changed');
        } finally {
          harness.database.close();
        }
      } finally {
        // Step 10: clean up the temp dir
        await rm(realRepoDir, { recursive: true, force: true });
      }
    },
    20000
  );
});

// ---------------------------------------------------------------------------
// Helper — build a Fastify app wrapping the control plane service
// ---------------------------------------------------------------------------

async function buildReconcileApp(
  harness: LifecycleHarness,
  opts?: { ticker?: { enabled: true; intervalMs: number; tenant: string } }
): Promise<FastifyInstance> {
  const now = '2026-06-17T00:00:00.000Z';
  const policy = permissivePolicyDecisionPoint;
  const eventBus = new InMemoryRunEventBus();

  const controlPlane = new DefaultControlPlaneService({
    orchestrator: harness.orchestrator,
    runs: harness.domainRepos.runs,
    runSteps: harness.domainRepos.runSteps,
    events: eventBus,
    policy,
    artifacts: harness.domainRepos.artifacts,
    feedback: harness.domainRepos.feedback,
    runWorkspaceMetadata: harness.domainRepos.runWorkspaceMetadata,
    // stub — filesystem is unused by the reconciliation code path
    workspaceFilesystem: { readFile: async () => '', writeFile: async () => undefined } as unknown as WorkspaceFileSystemPort,
    feedbackLifecycle: {
      feedback: harness.domainRepos.feedback,
      ids: () => `fb_${Math.random().toString(36).slice(2)}`,
      clock: () => now
    },
    projects: harness.domainRepos.projects,
    issueReferenceIntakeResolver: { resolve: async () => ({ kind: 'error' as const, code: 'tracker_not_found' as const }) },
    pullRequests: harness.domainRepos.pullRequests,
    sessions: harness.domainRepos.sessions
  });

  const app = Fastify({ logger: false });
  await registerControlPlaneRoutes(app, {
    health: { isDatabaseReachable: async () => true },
    auth: { bearerToken: RECONCILE_TEST_BEARER_TOKEN },
    policy,
    probeResources: new DrizzleProbeResourceRepository(harness.database),
    configurationRecords: new DrizzleConfigurationRecordRepository(harness.database),
    secrets: new SqliteSecretStore(harness.database),
    controlPlane
  });

  if (opts?.ticker?.enabled === true) {
    const systemPrincipal: NonModelPrincipal = {
      kind: 'system',
      id: 'principal_system_reconciliation',
      tenantId: opts.ticker.tenant
    };
    const ticker = createPullRequestReconciliationTicker({
      controlPlane,
      principal: systemPrincipal,
      tenant: opts.ticker.tenant,
      intervalMs: opts.ticker.intervalMs
    });
    ticker.start();
    app.addHook('onClose', async () => { ticker.stop(); });
  }

  return app;
}

// ---------------------------------------------------------------------------
// Test 4 — endpoint-driven reconciliation
// ---------------------------------------------------------------------------

describe('PR lifecycle integration: endpoint-driven reconciliation', () => {
  it('advances run from pr.human_review to done via POST /v1/pull-requests/reconcile', async () => {
    const unitOfWork: RunUnitOfWork = {
      run: async ({ run }) => {
        if (run.currentStep === 'pr.finalize') {
          return { directive: 'advance', result: prFinalizeAdvanceResult };
        }
        return { directive: 'advance' };
      }
    };

    const harness = await setupLifecycle({ unitOfWork });
    let app: FastifyInstance | undefined;
    try {
      const { orchestrator, domainRepos, fakeGh, run: runRef } = harness;

      await orchestrator.applyDirective({
        runId: runRef.id,
        directive: 'advance',
        tenant: 'tenant_dev',
        origin: 'human',
        principal: hardcodedDevelopmentPrincipal
      });

      await waitFor(
        async () => {
          const r = await domainRepos.runs.findById(runRef.id);
          if (r === null) throw new Error('run missing');
          return r;
        },
        (r) => r.currentStep === 'pr.human_review',
        7000,
        'pr.human_review'
      );

      const openPr = await domainRepos.pullRequests.findByRun(runRef.id);
      expect(openPr).not.toBeNull();
      expect(openPr!.state).toBe('open');

      fakeGh.setMerged();

      app = await buildReconcileApp(harness);
      const authorization = { authorization: `Bearer ${RECONCILE_TEST_BEARER_TOKEN}` };
      const response = await app.inject({
        method: 'POST',
        url: pullRequestReconciliationPath,
        headers: authorization
      });

      expect(response.statusCode).toBe(reconcilePullRequestsSuccessStatusCode);
      expect(response.json()).toEqual({ checked: 0, merged: 1, closed: 0, failed: 0, timedOut: false });
      expect(response.body).not.toContain(TEST_TOKEN);

      await waitFor(
        async () => {
          const r = await domainRepos.runs.findById(runRef.id);
          if (r === null) throw new Error('run missing');
          return r;
        },
        (r) => r.terminal === true && r.currentStep === 'done',
        5000,
        'done'
      );

      const mergedPr = await domainRepos.pullRequests.findByRun(runRef.id);
      expect(mergedPr).not.toBeNull();
      expect(mergedPr!.state).toBe('merged');
    } finally {
      if (app !== undefined) await app.close();
      harness.database.close();
    }
  }, 20000);
});

// ---------------------------------------------------------------------------
// Test 5 — ticker-driven reconciliation via createControlPlaneServer
// ---------------------------------------------------------------------------

describe('PR lifecycle integration: ticker-driven reconciliation', () => {
  it('advances run from pr.human_review to done via background ticker (createControlPlaneServer)', async () => {
    const now = '2026-06-17T00:00:00.000Z';
    const fakeGh = makeFakeGh({ branch: 'feature/ticker-integration' });
    fakeGh.state.createdPr = true;
    fakeGh.setMerged();

    const tempDir = await mkdtemp(join(tmpdir(), 'ac-ticker-integration-'));
    const dbPath = join(tempDir, 'ticker-test.sqlite');
    let runId = '';

    {
      const seedDb = createSqliteDatabase({ path: dbPath });
      await migrateSqliteDatabase(seedDb);
      const seedRepos = createDrizzleDomainRepositories(seedDb);

      const project = await seedRepos.projects.create({
        owner,
        tenant: 'tenant_dev',
        displayName: 'Ticker Integration Project',
        repoUrl: `https://github.com/${REPO_SLUG}`,
        hostRepository: { provider: 'github', owner: REPO_OWNER, name: REPO_NAME, url: `https://github.com/${REPO_SLUG}` },
        workspaceRootOverride: null,
        issueTrackerSetting: null,
        codeHostSetting: { provider: 'github', credentialRef: { id: 'cred_ticker_test', purpose: 'code_host' } },
        credentialRefs: []
      });

      const seed = await new DrizzleConversationIngressRepository(seedDb)
        .createConversationTopicMessageAndRun({
          conversation: {
            projectId: project.id,
            owner,
            tenant: 'tenant_dev',
            identity: 'ticker-integration-test',
            activeTopicId: null
          },
          topic: { owner, tenant: 'tenant_dev', title: 'Ticker Integration Topic', kind: 'main' },
          message: { owner, tenant: 'tenant_dev', author: owner, direction: 'inbound', body: 'ticker integration' },
          run: { owner, tenant: 'tenant_dev', workKind: 'feature', currentStep: 'pr.human_review', terminal: false },
          runStep: {
            phase: 'pr',
            step: 'pr.human_review',
            role: 'none',
            startedAt: now,
            endedAt: null,
            durationMs: null
          }
        });
      runId = seed.run.id;
      const branch = `feature/${runId.slice(0, 8)}`;

      const buildStep = await seedRepos.runSteps.create({
        runId,
        phase: 'implementation',
        step: 'implementation.build',
        role: 'none',
        startedAt: now,
        endedAt: now,
        durationMs: 1000,
        occurrence: { index: 0, attempt: 1 }
      });
      await seedRepos.runSteps.updateCheckpoint({
        runStepId: buildStep.id,
        runId,
        tenant: 'tenant_dev',
        checkpointResult: {
          kind: 'cumulative_implementation_summary',
          cumulativeSummary: 'Added ticker test feature.',
          changedFiles: ['src/ticker.ts'],
          validationSummary: ['All tests pass'],
          followUps: [],
          nonGoals: [],
          sourceRoundCount: 1,
          completedAt: now
        } as unknown as Parameters<typeof seedRepos.runSteps.updateCheckpoint>[0]['checkpointResult']
      });

      await seedRepos.runWorkspaceMetadata.upsert({
        runId,
        workspaceHandle: branch,
        workspaceRepoRoot: '/tmp/fake-workspace',
        createdAt: now
      });

      await seedRepos.pullRequests.create({
        runId,
        owner,
        tenant: 'tenant_dev',
        provider: 'github',
        number: PR_NUMBER,
        url: PR_URL,
        state: 'open',
        branch
      });

      seedDb.close();
    }

    const TICKER_BEARER_TOKEN = 'ticker-integration-bearer-token';
    const app = await createControlPlaneServer({
      databasePath: dbPath,
      bearerToken: TICKER_BEARER_TOKEN,
      masterSecret: 'ticker-integration-master-secret',
      codeHost: { executeGh: fakeGh.executeGh },
      resolveCredential: async () => ({ token: TEST_TOKEN }),
      pullRequestReconciliationTicker: { enabled: true, intervalMs: 50, tenant: 'tenant_dev' }
    });

    try {
      const finalRun = await waitFor(
        async () => {
          const response = await app.inject({
            method: 'GET',
            url: `/v1/runs/${runId}`,
            headers: { authorization: `Bearer ${TICKER_BEARER_TOKEN}` }
          });
          return response.json() as { currentStep: string; terminal: boolean };
        },
        (r) => r.terminal === true && r.currentStep === 'done',
        7000,
        'done via createControlPlaneServer ticker'
      );
      expect(finalRun.currentStep).toBe('done');
      expect(finalRun.terminal).toBe(true);
    } finally {
      await app.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 20000);
});

// ---------------------------------------------------------------------------
// Test 6 — closed-without-merge containment
// ---------------------------------------------------------------------------

describe('PR lifecycle integration: closed-without-merge containment', () => {
  it('records closed state and fails run when PR is closed without merge', async () => {
    const unitOfWork: RunUnitOfWork = {
      run: async ({ run }) => {
        if (run.currentStep === 'pr.finalize') {
          return { directive: 'advance', result: prFinalizeAdvanceResult };
        }
        return { directive: 'advance' };
      }
    };

    const harness = await setupLifecycle({ unitOfWork });
    let app: FastifyInstance | undefined;
    try {
      const { orchestrator, domainRepos, fakeGh, run: runRef } = harness;

      await orchestrator.applyDirective({
        runId: runRef.id,
        directive: 'advance',
        tenant: 'tenant_dev',
        origin: 'human',
        principal: hardcodedDevelopmentPrincipal
      });

      await waitFor(
        async () => {
          const r = await domainRepos.runs.findById(runRef.id);
          if (r === null) throw new Error('run missing');
          return r;
        },
        (r) => r.currentStep === 'pr.human_review',
        7000,
        'pr.human_review'
      );

      const openPr = await domainRepos.pullRequests.findByRun(runRef.id);
      expect(openPr).not.toBeNull();
      expect(openPr!.state).toBe('open');

      fakeGh.setClosed();

      app = await buildReconcileApp(harness);
      const authorization = { authorization: `Bearer ${RECONCILE_TEST_BEARER_TOKEN}` };
      const response = await app.inject({
        method: 'POST',
        url: pullRequestReconciliationPath,
        headers: authorization
      });

      expect(response.statusCode).toBe(reconcilePullRequestsSuccessStatusCode);
      expect(response.json()).toMatchObject({ checked: 0, merged: 0, closed: 1 });
      expect(response.body).not.toContain(TEST_TOKEN);

      await waitFor(
        async () => {
          const r = await domainRepos.runs.findById(runRef.id);
          if (r === null) throw new Error('run missing');
          return r;
        },
        (r) => r.terminal === true,
        5000,
        'terminal run after closed PR'
      );

      const finalRun = await domainRepos.runs.findById(runRef.id);
      expect(finalRun).not.toBeNull();
      expect(finalRun!.currentStep).not.toBe('done');
      expect(finalRun!.failureReason).toBe('pull_request_closed_without_merge');

      const closedPr = await domainRepos.pullRequests.findByRun(runRef.id);
      expect(closedPr).not.toBeNull();
      expect(closedPr!.state).toBe('closed');
    } finally {
      if (app !== undefined) await app.close();
      harness.database.close();
    }
  }, 20000);
});

describe('PR refresh through createControlPlaneServer', () => {
  const at = '2026-06-17T00:00:00.000Z';

  async function withRefreshServer(test: (fixtures: {
    app: FastifyInstance;
    service: ControlPlaneService;
    fakeGh: FakeGhHandle;
    projectId: string;
    refresh(runId: string): Promise<LightMyRequestResponse>;
    seedRun(label: string, step?: string, state?: PullRequest['state']): Promise<string>;
    setPrincipal(principal: Principal): void;
    rejectHostRead(code: GhExecError['code']): void;
    failPrWrite(): void;
  }) => Promise<void>) {
    const dir = await mkdtemp(join(tmpdir(), 'ac-pr-refresh-'));
    const databasePath = join(dir, 'refresh.sqlite');
    const database = createSqliteDatabase({ path: databasePath });
    let app: FastifyInstance | undefined;
    try {
      await migrateSqliteDatabase(database);
      const masterSecret = 'refresh-integration-master-secret';
      const secretStore = new SqliteSecretStore(database);
      await secretStore.unlock(masterSecret);
      const { handle } = await secretStore.createSecret({ value: TEST_TOKEN });
      const repos = createDrizzleDomainRepositories(database);
      const project = await repos.projects.create({
        owner, tenant: owner.tenantId, displayName: 'Refresh integration project',
        repoUrl: `https://github.com/${REPO_SLUG}`,
        hostRepository: { provider: 'github', owner: REPO_OWNER, name: REPO_NAME },
        workspaceRootOverride: null, issueTrackerSetting: null, credentialRefs: [],
        codeHostSetting: { provider: 'github', credentialRef: { id: handle, purpose: 'code_host' } }
      });
      const branch = 'feature/refresh-integration';
      const fakeGh = makeFakeGh({ branch });
      const ingress = new DrizzleConversationIngressRepository(database);

      async function seedRun(label: string, step = 'pr.human_review', state: PullRequest['state'] = 'open') {
        const { run } = await ingress.createConversationTopicMessageAndRun({
          conversation: { projectId: project.id, owner, tenant: owner.tenantId, identity: label, activeTopicId: null },
          topic: { owner, tenant: owner.tenantId, title: label, kind: 'main' },
          message: { owner, tenant: owner.tenantId, author: owner, direction: 'inbound', body: label },
          run: { owner, tenant: owner.tenantId, workKind: 'feature', currentStep: step, terminal: false },
          runStep: { phase: 'pr', step, role: 'none', startedAt: at, endedAt: null, durationMs: null }
        });
        await repos.pullRequests.create({
          runId: run.id, owner, tenant: owner.tenantId, provider: 'github', number: PR_NUMBER, url: PR_URL, state: 'open', branch
        });
        if (state !== 'open') {
          await repos.pullRequests.updateState({ runId: run.id, tenant: owner.tenantId, state, updatedAt: at, expectedState: 'open' });
        }
        return run.id;
      }

      let principal: Principal = owner;
      let readError: GhExecError['code'] | undefined;
      let service: ControlPlaneService | undefined;
      const bearerToken = 'targeted-refresh-token';
      const server = await createControlPlaneServer({
        databasePath, masterSecret, bearerToken,
        resolvePrincipal: () => principal,
        autoDispatch: { enabled: false },
        pullRequestReconciliationTicker: { enabled: false, tenant: owner.tenantId, intervalMs: 50 },
        onControlPlaneReady: (ready) => { service = ready; },
        codeHost: {
          executeGh: async (input) => {
            if (readError !== undefined) throw new GhExecError(readError, 'SECRET_SENTINEL provider credential ' + TEST_TOKEN);
            return fakeGh.executeGh(input);
          }
        }
      });
      app = server;
      if (service === undefined) throw new Error('Control plane not ready');
      await test({
        app: server, service, fakeGh, projectId: project.id,
        refresh: (runId) => server.inject({
          method: 'POST', url: `/v1/runs/${runId}/pull-request/refresh`,
          headers: { authorization: `Bearer ${bearerToken}`, 'content-type': 'application/json' }, payload: '{}'
        }),
        seedRun,
        setPrincipal: (value) => { principal = value; },
        rejectHostRead: (code) => { readError = code; },
        failPrWrite: () => {
          asInternalSqliteDatabase(database).client.exec(
            "CREATE TRIGGER fail_pr_write BEFORE UPDATE ON pull_requests " +
            "BEGIN SELECT RAISE(ABORT, 'SECRET_SENTINEL local write fault'); END;"
          );
        }
      });
    } finally {
      await app?.close();
      database.close();
      await rm(dir, { recursive: true, force: true });
    }
  }

  async function transitions(service: ControlPlaneService, runId: string) {
    const replay = await service.replayRunEvents({ principal: owner, tenant: owner.tenantId, runId, replay: 'retained' });
    if (replay.status !== 'ok') throw new Error('Expected retained replay');
    return replay.events.filter((event) => event.type === 'run_state_transition');
  }

  it('checks open, detects merge, and replays without contacting GitHub', async () => {
    await withRefreshServer(async ({ service, fakeGh, projectId, refresh, seedRun }) => {
      // Exercise the production pr.open resume path with an already-recorded open PR.
      const runId = await seedRun('merge', 'pr.open');
      const scope = { principal: owner, tenant: owner.tenantId, runId };
      await service.tick(scope);
      const getReads = () => fakeGh.calls.filter((call) => call.args[1] === 'view');
      // tick dispatches pr.open and also starts a detached batch check, even with the ticker off.
      await vi.waitFor(() => expect(getReads()).toHaveLength(2));
      const setupReads = getReads().length;
      const beforeRun = await service.getRun(scope);
      const beforePr = await service.getRunPullRequest(scope);
      const beforeEvents = await transitions(service, runId);
      expect(beforeRun.run).toMatchObject({ currentStep: 'pr.human_review', projectId, waitingOn: 'human', status: 'in_progress' });

      const open = await refresh(runId);
      expect(open.statusCode).toBe(200);
      expect(runPullRequestRefreshResponseSchema.parse(open.json())).toEqual({ ...beforeRun, ...beforePr });
      expect(await transitions(service, runId)).toEqual(beforeEvents);
      expect(getReads()).toHaveLength(setupReads + 1);
      expect(fakeGh.calls.at(-1)).toMatchObject({ args: expect.arrayContaining(['pr', 'view', String(PR_NUMBER), REPO_SLUG]), token: TEST_TOKEN });

      fakeGh.setMerged();
      const merged = await refresh(runId);
      expect(merged.statusCode).toBe(200);
      expect(runPullRequestRefreshResponseSchema.parse(merged.json())).toMatchObject({
        pullRequest: { state: 'merged' },
        run: { currentStep: 'done', terminal: true, status: 'done', waitingOn: 'none', projectId }
      });
      const reads = getReads();
      expect(reads).toHaveLength(setupReads + 2);
      expect(await transitions(service, runId)).toHaveLength(beforeEvents.length + 1);
      expect((await refresh(runId)).json()).toEqual(merged.json());
      expect(getReads()).toEqual(reads);
      expect(await transitions(service, runId)).toHaveLength(beforeEvents.length + 1);
    });
  }, 15000);

  it('masks foreign runs and distinguishes ineligibility, closure, and provider auth failure', async () => {
    await withRefreshServer(async ({ service, fakeGh, refresh, seedRun, setPrincipal, rejectHostRead }) => {
      const offGate = await seedRun('off-gate', 'pr.finalize');
      const mismatch = await seedRun('mismatch', 'pr.finalize', 'merged');
      const closeRun = await seedRun('close');
      const authRun = await seedRun('auth');
      const offGateResult = await refresh(offGate);
      expect(offGateResult.statusCode).toBe(409);
      expect(offGateResult.json()).toEqual({
        error: { code: 'conflict', message: 'Run is not waiting at the pull request gate.' }
      });
      const incompatible = await refresh(mismatch);
      expect(incompatible.statusCode).toBe(409);
      expect(incompatible.json()).toEqual({
        error: { code: 'conflict', message: 'The stored pull request outcome does not match the run state.' }
      });
      const absent = await refresh('missing');
      expect(absent.statusCode).toBe(404);
      setPrincipal({ ...owner, tenantId: 'other_tenant' });
      const foreign = await refresh(closeRun);
      expect(foreign.statusCode).toBe(404);
      expect(foreign.json().error.code).toBe('not_found');
      // Direct service callers cannot bypass the protected action's model denial.
      await expect(service.refreshRunPullRequest({
        principal: { kind: 'model', id: 'model_refresh', tenantId: owner.tenantId },
        runId: closeRun
      })).rejects.toMatchObject({ code: 'forbidden' });
      expect(fakeGh.calls).toHaveLength(0);
      setPrincipal(owner);

      fakeGh.setClosed();
      const closed = await refresh(closeRun);
      expect(closed.statusCode).toBe(200);
      expect(closed.json()).toMatchObject({
        pullRequest: { state: 'closed' },
        run: { currentStep: 'failed', status: 'failed', failureReason: 'pull_request_closed_without_merge' }
      });
      expect(await transitions(service, closeRun)).toHaveLength(1);

      rejectHostRead('gh_auth_failed');
      const scope = { principal: owner, tenant: owner.tenantId, runId: authRun };
      const before = { ...await service.getRun(scope), ...await service.getRunPullRequest(scope) };
      const unauthorized = await refresh(authRun);
      expect(unauthorized.statusCode).toBe(502);
      expect(unauthorized.json()).toEqual({
        error: { code: 'pull_request_check_failed', message: 'Could not check the pull request.', details: { reason: 'authentication_failed' } }
      });
      expect({ ...await service.getRun(scope), ...await service.getRunPullRequest(scope) }).toEqual(before);
      expect(await transitions(service, authRun)).toHaveLength(0);
    });
  }, 15000);

  it('does not report a SQLite write fault as a failed host check or as a successful merge', async () => {
    await withRefreshServer(async ({ service, fakeGh, refresh, seedRun, failPrWrite }) => {
      const runId = await seedRun('write-fault');
      const scope = { principal: owner, tenant: owner.tenantId, runId };
      const before = { ...await service.getRun(scope), ...await service.getRunPullRequest(scope) };
      failPrWrite();
      fakeGh.setMerged();

      const result = await refresh(runId);
      expect(result.statusCode).toBe(500);
      expect(result.json()).toEqual({
        error: { code: 'internal_error', message: 'An internal server error occurred.' }
      });
      expect(fakeGh.calls.filter((call) => call.args[1] === 'view')).toHaveLength(1);
      expect({ ...await service.getRun(scope), ...await service.getRunPullRequest(scope) }).toEqual(before);
      expect(await transitions(service, runId)).toHaveLength(0);
    });
  }, 15000);

  it('repairs a stored merge and replays it without reading GitHub or touching the PR', async () => {
    await withRefreshServer(async ({ service, fakeGh, refresh, rejectHostRead, seedRun }) => {
      const runId = await seedRun('repair', 'pr.human_review', 'merged');
      rejectHostRead('gh_timeout');
      const before = await service.getRunPullRequest({ principal: owner, tenant: owner.tenantId, runId });
      const result = await refresh(runId);
      expect(result.statusCode).toBe(200);
      expect(result.json()).toMatchObject({ ...before, run: { currentStep: 'done', status: 'done' } });
      expect((await refresh(runId)).json()).toEqual(result.json());
      expect(fakeGh.calls).toHaveLength(0);
      expect(await transitions(service, runId)).toHaveLength(1);
      const { steps } = await service.listRunSteps({ principal: owner, tenant: owner.tenantId, runId });
      expect(steps.find((step) => step.step === 'pr.human_review')?.checkpointResult).toEqual({
        kind: 'pull_request_merged', provider: 'github', number: PR_NUMBER, url: PR_URL, mergedAt: at
      });
    });
  }, 15000);
});
