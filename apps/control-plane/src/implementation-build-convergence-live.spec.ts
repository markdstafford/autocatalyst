/**
 * Opt-in live e2e test for the implementation.build convergence path.
 *
 * Requires both:
 *   - AUTOCATALYST_LIVE_IMPLEMENTATION_CONVERGENCE=1
 *   - ANTHROPIC_API_KEY or OPENAI_API_KEY set in the environment
 *
 * All tests are SKIPPED unless both conditions are met. CI never sets
 * AUTOCATALYST_LIVE_IMPLEMENTATION_CONVERGENCE, so this suite never runs in CI.
 *
 * When enabled, this test uses the REAL convergence engine wired through
 * `DefaultOrchestrator` with a live AI provider. The `ReviewedRoleDispatcher`
 * is the real `ReviewedExecutionDispatcher` backed by actual API calls. The
 * implementer writes/commits code and the reviewer assesses with read-only tools.
 *
 * Assertions:
 *   - Happy path: reviewer is satisfied → run advances to implementation.human_review
 *   - Forced stall: maxRounds=1 + reviewer prompt instructs a warning → pauses at implementation.awaiting_input
 *   - Logs do not contain API key values from the environment
 */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Project } from '@autocatalyst/api-contract';
import {
  createConvergenceEngine,
  createLayeredConvergenceEngine,
  createExecutionContextResolver,
  createExecutionRunUnitOfWork,
  DefaultOrchestrator,
  getRunStepDefinition,
  getStepConvergencePolicy,
  hardcodedDevelopmentPrincipal,
  InMemoryRetainedRunEventStore,
  RunDispatchQueue,
  type ModelRoutingResolver,
  type ModelRoutingResolution,
  type ReviewedRoleDispatcher,
  type ReviewedRoleDispatchResult,
  type RunRoleWorkInput,
  type RunWorkflowDefinition,
  type RunStepId,
  type StepConvergencePolicy,
  type WorkspaceContextResolver,
  type ResolvedStepConvergencePolicy
} from '@autocatalyst/core';
import {
  claudeAgentAdapterId,
  claudeProviderKind,
  createClaudeAgentAdapter
} from '@autocatalyst/claude-agent-adapter';
import {
  createAgentConnection,
  createAgentRunnerFactory,
  createExecutionMaterializer,
  getAgentProviderAdapterKey,
  type ProviderCredentialResolver
} from '@autocatalyst/execution';
import {
  openaiAgentAdapterId,
  openaiProviderKind,
  createOpenAIAgentAdapter
} from '@autocatalyst/openai-agent-adapter';
import {
  createDrizzleDomainRepositories,
  createSqliteDatabase,
  migrateSqliteDatabase
} from '@autocatalyst/persistence';

import { createDelegatingExecutionEntryPoint } from './server.js';
import { createReviewedExecutionDispatcher } from './reviewed-execution-dispatcher.js';
import { createRunWorkspaceGitPort } from './run-workspace-git-port.js';

// ---------------------------------------------------------------------------
// Gate: skip everything unless LIVE env vars are present
// ---------------------------------------------------------------------------

const LIVE_ENABLED =
  process.env['AUTOCATALYST_LIVE_IMPLEMENTATION_CONVERGENCE'] === '1' &&
  (process.env['ANTHROPIC_API_KEY'] !== undefined || process.env['OPENAI_API_KEY'] !== undefined);

// ---------------------------------------------------------------------------
// Helpers shared with the deterministic smoke test
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

const TENANT = hardcodedDevelopmentPrincipal.tenantId;
const OWNER = hardcodedDevelopmentPrincipal;

// Stub project for ExecutionContext workspace provisioning.
// The provisionWorkspace seam bypasses real provisioning, so only structural
// validity of this object matters.
const LIVE_TEST_PROJECT: Project = {
  id: 'proj-live-test',
  owner: OWNER,
  tenant: TENANT,
  displayName: 'Live Test Project',
  repoUrl: 'https://github.test/live/test',
  hostRepository: { provider: 'github', owner: 'live', name: 'test' },
  workspaceRootOverride: null,
  issueTrackerSetting: null,
  codeHostSetting: null,
  credentialRefs: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
};

async function withTempDir<T>(prefix: string, run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function initGitRepo(repoRoot: string): Promise<void> {
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
  await execFileAsync('git', ['config', 'user.name', 'Autocatalyst Test'], { cwd: repoRoot });
  await execFileAsync('git', ['config', 'user.email', 'autocatalyst-test@local'], { cwd: repoRoot });
  await execFileAsync('git', ['commit', '--allow-empty', '-m', 'root'], { cwd: repoRoot });
}

// ---------------------------------------------------------------------------
// Routing stub: two distinct profiles for implementer/reviewer.
// The credentialReference uses secretHandle so createAgentConnection resolves
// the API key from the provided credentialResolver (env var closure).
// ---------------------------------------------------------------------------

function makeLiveRouting(): ModelRoutingResolver {
  const useAnthropic = process.env['ANTHROPIC_API_KEY'] !== undefined;

  const implResolution: ModelRoutingResolution = {
    routeId: 'route_impl_live',
    profileId: 'profile_impl_live',
    routingTableId: 'table_live',
    profile: {
      mode: 'agent',
      providerKind: useAnthropic ? claudeProviderKind : openaiProviderKind,
      adapterId: useAnthropic ? claudeAgentAdapterId : openaiAgentAdapterId,
      configurationRecordId: 'cfg_impl_live',
      profileName: 'impl-profile-live',
      model: useAnthropic
        ? { provider: 'anthropic', model: 'claude-haiku-4' }
        : { provider: 'openai', model: 'gpt-4o-mini' },
      inferenceSettings: {},
      endpoint: {},
      connectionMechanism: useAnthropic ? 'process_environment' : 'fetch_transport'
    },
    credentialReference: {
      required: true,
      secretHandle: 'live-api-key'
    }
  };

  const revResolution: ModelRoutingResolution = {
    routeId: 'route_rev_live',
    profileId: 'profile_rev_live',
    routingTableId: 'table_live',
    profile: {
      mode: 'agent',
      providerKind: useAnthropic ? claudeProviderKind : openaiProviderKind,
      adapterId: useAnthropic ? claudeAgentAdapterId : openaiAgentAdapterId,
      configurationRecordId: 'cfg_rev_live',
      profileName: 'rev-profile-live',
      model: useAnthropic
        ? { provider: 'anthropic', model: 'claude-haiku-4' }
        : { provider: 'openai', model: 'gpt-4o-mini' },
      inferenceSettings: {},
      endpoint: {},
      connectionMechanism: useAnthropic ? 'process_environment' : 'fetch_transport'
    },
    credentialReference: {
      required: true,
      secretHandle: 'live-api-key'
    }
  };

  return {
    async resolveAgentRoute() {
      throw new Error('resolveAgentRoute not expected for distinct path');
    },
    async resolveDirectRoute() {
      throw new Error('resolveDirectRoute not used by convergence engine');
    },
    async resolveDistinctAgentRoutes() {
      return {
        step: 'implementation.build',
        distinctBy: 'model' as const,
        resolutionsByRole: {
          implementer: implResolution,
          reviewer: revResolution
        }
      };
    }
  };
}

// ---------------------------------------------------------------------------
// Real reviewed dispatcher backed by live AI API
//
// Replaces createMinimalLiveDispatcher. Uses createReviewedExecutionDispatcher
// wired through createDelegatingExecutionEntryPoint so both the implementer
// and reviewer sessions call the actual provider.
//
// The provisionWorkspace seam is injected to return the pre-existing temp
// workspace so no real git clone is performed.
//
// `scenario: 'stall'` sets the reviewer prompt to always return a warning
// finding, making the max_rounds outcome deterministic.
// ---------------------------------------------------------------------------

interface LiveDispatcherOptions {
  readonly workspacesRoot: string;
  readonly workspaceRepoRoot: string;
  readonly runId: string;
  readonly scenario: 'happy' | 'stall';
}

async function createLiveReviewedDispatcher(
  options: LiveDispatcherOptions
): Promise<ReviewedRoleDispatcher> {
  const { workspacesRoot, workspaceRepoRoot, runId, scenario } = options;

  const scratchRoot = join(workspacesRoot, 'scratch');
  await mkdir(scratchRoot, { recursive: true });

  const useAnthropic = process.env['ANTHROPIC_API_KEY'] !== undefined;

  // Adapter registry — Claude or OpenAI based on which key is available.
  const adapterKey = getAgentProviderAdapterKey(
    useAnthropic ? claudeProviderKind : openaiProviderKind,
    useAnthropic ? claudeAgentAdapterId : openaiAgentAdapterId
  );
  const adapterRegistry = new Map([
    [adapterKey, useAnthropic ? createClaudeAgentAdapter() : createOpenAIAgentAdapter()]
  ]);

  // Credential resolver: return the API key from process.env for the 'live-api-key' handle.
  const credentialResolver: ProviderCredentialResolver = {
    async resolveCredential(_handle: string): Promise<string | undefined> {
      return useAnthropic
        ? process.env['ANTHROPIC_API_KEY']
        : process.env['OPENAI_API_KEY'];
    }
  };

  // Routing stub for profile selection by role.
  const routing = makeLiveRouting();

  // Runner factory: resolves profile per role, creates real connection.
  const runnerFactory = createAgentRunnerFactory({
    adapters: adapterRegistry,
    resolveProfile: async (factoryInput) => {
      const distinct = await routing.resolveDistinctAgentRoutes({
        tenant: TENANT,
        runId: factoryInput.runId,
        step: factoryInput.step,
        roles: ['implementer', 'reviewer']
      });
      const role = factoryInput.role ?? 'implementer';
      const resolution = distinct.resolutionsByRole[role as keyof typeof distinct.resolutionsByRole]
        ?? distinct.resolutionsByRole['implementer'];
      return { profile: resolution.profile, credentialReference: resolution.credentialReference };
    },
    createConnection: async (input) => createAgentConnection({
      profile: input.profile,
      credentialReference: input.credentialReference,
      credentialResolver,
      telemetryContext: input.telemetryContext
    })
  });

  // Materializer: inject provisionWorkspace to return the pre-existing workspace.
  const materializer = createExecutionMaterializer({
    capabilities: { shellAvailable: true, lspAvailable: false },
    provisionWorkspace: async () => ({
      shape: 'two_roots' as const,
      runId,
      workspaceRoot: workspacesRoot,
      runRoot: workspacesRoot,
      repoRoot: workspaceRepoRoot,
      scratchRoot,
      hostRepositoryPath: workspaceRepoRoot,
      branchName: 'main'
    })
  });

  // Entry point: routes role from task.inputs.role so the runner factory
  // receives the correct role on each round.
  const entryPoint = createDelegatingExecutionEntryPoint({
    factory: runnerFactory,
    materialize: (context) => materializer.materialize(context)
  });

  // Unit of work: builds ExecutionContext directly, no DB lookups.
  // Prompt and tool policy differ by role and scenario.
  const unitOfWork = createExecutionRunUnitOfWork({
    execute: entryPoint,
    resolveContext: async (workInput) => {
      const ri = workInput as RunRoleWorkInput;
      const isReviewer = ri.role === 'reviewer';

      const prompt = isReviewer
        ? (scenario === 'stall'
          ? 'You are reviewing code changes. Return ONLY the following JSON as your step result: {"status":"findings","findings":[{"title":"Stall test finding","body":"Always returned for forced stall test.","severity":"warning"}]}'
          : 'Review the repository. If a file hello.txt exists with content starting with "Hello", return {"status":"satisfied"}. Otherwise return {"status":"findings","findings":[{"title":"Missing file","body":"Expected hello.txt was not found.","severity":"warning"}]}.')
        : 'Create a file named hello.txt in the repository root with the content "Hello from the live convergence test". Stage and commit the file with a short commit message.';

      return createExecutionContextResolver({
        workspace: {
          project: LIVE_TEST_PROJECT,
          roots: { reposRoot: workspacesRoot, workspacesRoot },
          topicSlug: 'live-test',
          shortRunId: runId.slice(0, 8),
          defaultBranch: 'main'
        },
        ...(isReviewer ? { toolPolicy: { allowedTools: ['Read', 'Glob', 'Grep'] } } : {}),
        prompt,
        taskInputs: (input) => {
          const roleInput = input as RunRoleWorkInput;
          return {
            role: roleInput.role ?? 'implementer',
            round: roleInput.round ?? 1,
            ...(roleInput.role === 'reviewer'
              ? { sessionMode: 'code_review', accessMode: 'read_only' }
              : {})
          };
        },
        // Disable skill resolution — implementation.build has no skill refs.
        resolveSkills: async () => ({ requested: [], resolved: [] }),
        capabilityRequirements: {
          shell: { required: false },
          paths: { canonicalWorkspacePaths: false },
          lsp: { requested: false }
        }
      }).resolve(workInput);
    }
  });

  return createReviewedExecutionDispatcher({ unitOfWork });
}

// ---------------------------------------------------------------------------
// Tracking wrapper — counts role calls so tests can assert call patterns.
// ---------------------------------------------------------------------------

function wrapWithCallTracking(
  dispatcher: ReviewedRoleDispatcher
): ReviewedRoleDispatcher & { calls: RunRoleWorkInput[] } {
  const calls: RunRoleWorkInput[] = [];
  return {
    calls,
    async runRole(input: RunRoleWorkInput): Promise<ReviewedRoleDispatchResult> {
      calls.push(input);
      return dispatcher.runRole(input);
    }
  };
}

// ---------------------------------------------------------------------------
// Database seed helpers (same as smoke test)
// ---------------------------------------------------------------------------

async function seedLiveRun(
  databasePath: string,
  workspaceRepoRoot: string
): Promise<{ runId: string }> {
  const seedDb = createSqliteDatabase({ path: databasePath });
  await migrateSqliteDatabase(seedDb);
  const repos = createDrizzleDomainRepositories(seedDb);

  const project = await repos.projects.create({
    owner: OWNER,
    tenant: TENANT,
    displayName: 'Live Convergence Project',
    repoUrl: 'https://example.test/live-convergence',
    hostRepository: { provider: 'github', owner: 'test', name: 'live-convergence' },
    workspaceRootOverride: null,
    issueTrackerSetting: null,
    codeHostSetting: null,
    credentialRefs: []
  });
  const conversation = await repos.conversations.create({
    projectId: project.id,
    owner: OWNER,
    tenant: TENANT,
    identity: 'live-convergence-conv',
    activeTopicId: null
  });
  const topic = await repos.topics.create({
    conversationId: conversation.id,
    owner: OWNER,
    tenant: TENANT,
    title: 'Live convergence topic',
    kind: 'main'
  });

  const run = await repos.runs.create({
    topicId: topic.id,
    owner: OWNER,
    tenant: TENANT,
    workKind: 'chore',
    currentStep: 'implementation.build',
    terminal: false
  });

  await repos.runSteps.create({
    runId: run.id,
    phase: 'implementation',
    step: 'implementation.build',
    role: 'implementer',
    startedAt: new Date().toISOString(),
    endedAt: null,
    durationMs: null,
    occurrence: { index: 0, attempt: 1, key: 'live-impl-build-0' }
  });

  await repos.runWorkspaceMetadata.upsert({
    runId: run.id,
    workspaceHandle: 'live-workspace',
    workspaceRepoRoot,
    createdAt: new Date().toISOString()
  });

  seedDb.close();
  return { runId: run.id };
}

// ---------------------------------------------------------------------------
// Scenario scaffolding
// ---------------------------------------------------------------------------

interface LiveScenarioHandles {
  readonly runId: string;
  readonly workspacesRoot: string;
  readonly workspaceRepoRoot: string;
  readonly databasePath: string;
}

async function withLiveScenario(
  prefix: string,
  body: (handles: LiveScenarioHandles) => Promise<void>
): Promise<void> {
  await withTempDir(`${prefix}-ws-`, async (workspacesRoot) => {
    await withTempDir(`${prefix}-db-`, async (dbDir) => {
      const databasePath = join(dbDir, 'control-plane.sqlite');
      const workspaceRepoRoot = join(workspacesRoot, 'repo');
      const fs = await import('node:fs/promises');
      await fs.mkdir(workspaceRepoRoot, { recursive: true });
      await initGitRepo(workspaceRepoRoot);

      const { runId } = await seedLiveRun(databasePath, workspaceRepoRoot);

      await body({ runId, workspacesRoot, workspaceRepoRoot, databasePath });
    });
  });
}

function buildLiveOrchestrator(input: {
  readonly databasePath: string;
  readonly workspacesRoot: string;
  readonly workspaceRepoRoot: string;
  readonly dispatcher: ReviewedRoleDispatcher;
  readonly getPolicy?: (workflow: RunWorkflowDefinition, step: RunStepId) => Required<StepConvergencePolicy>;
  // When depth is provided, uses createLayeredConvergenceEngine for altitude-aware convergence.
  // Note: providers must enforce reviewer read-only access; skip this scenario if they do not.
  readonly depth?: ResolvedStepConvergencePolicy['depth'];
}): { orchestrator: DefaultOrchestrator; close: () => void } {
  const database = createSqliteDatabase({ path: input.databasePath });
  const domainRepos = createDrizzleDomainRepositories(database);

  const eventBus = new InMemoryRetainedRunEventStore({
    maxEventsPerScope: 256,
    maxExpiredIdsPerScope: 64,
    subscriberBufferSize: 32
  });
  const dispatchQueue = new RunDispatchQueue({ maxConcurrent: 1 });

  const runWorkspaceGit = createRunWorkspaceGitPort({ workspacesRoot: input.workspacesRoot });
  const routing = makeLiveRouting();

  const resolvedDepth = input.depth;
  // build_only (or absent) uses the legacy build-only engine for backward compatibility.
  const convergenceEngine = resolvedDepth !== undefined && resolvedDepth !== 'build_only'
    ? createLayeredConvergenceEngine({
        dispatcher: input.dispatcher,
        git: runWorkspaceGit,
        feedback: domainRepos.feedback,
        runSteps: domainRepos.runSteps,
        routing,
        getPolicy: () => ({ maxRounds: 3, depth: resolvedDepth }),
        logger: { warn: () => {} }
      })
    : createConvergenceEngine({
        dispatcher: input.dispatcher,
        git: runWorkspaceGit,
        feedback: domainRepos.feedback,
        runSteps: domainRepos.runSteps,
        routing,
        getPolicy: input.getPolicy ?? getStepConvergencePolicy,
        logger: { warn: () => {} }
      });

  const resolveWorkspaceContext: WorkspaceContextResolver = async () => ({
    workspaceRepoRoot: input.workspaceRepoRoot,
    workspaceHandle: 'live-workspace'
  });

  const orchestrator = new DefaultOrchestrator({
    runs: domainRepos.runs,
    conversationIngress: {
      createConversationTopicMessageAndRun: () => {
        throw new Error('not used in live convergence test');
      }
    },
    events: eventBus,
    dispatchQueue,
    runSteps: domainRepos.runSteps,
    runWorkspaceMetadata: domainRepos.runWorkspaceMetadata,
    resolveWorkspaceContext,
    convergenceEngine,
    autoDispatch: { enabled: false },
    logger: { warn: () => {} }
  });

  return { orchestrator, close: () => database.close() };
}

// ---------------------------------------------------------------------------
// Secret-absence helper
// ---------------------------------------------------------------------------

/**
 * Returns the set of non-empty API key values present in the environment.
 * We collect them before tests run so assertions can check captured output
 * does not contain any of these values.
 */
function collectSecretValues(): readonly string[] {
  const keys = [
    process.env['ANTHROPIC_API_KEY'],
    process.env['OPENAI_API_KEY']
  ];
  return keys.filter((v): v is string => typeof v === 'string' && v.length > 0);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!LIVE_ENABLED)('live implementation.build convergence e2e', () => {
  let secretValues: readonly string[] = [];
  const capturedWarnings: string[] = [];
  const originalConsoleWarn = console.warn;

  beforeAll(() => {
    secretValues = collectSecretValues();
    // Intercept console.warn so we can assert secrets are absent in log output.
    console.warn = (...args: unknown[]) => {
      capturedWarnings.push(args.map(String).join(' '));
    };
  });

  afterAll(() => {
    console.warn = originalConsoleWarn;
  });

  it('happy path converges and advances to implementation.human_review', async () => {
    await withLiveScenario('ac-live-happy', async ({ runId, workspacesRoot, workspaceRepoRoot, databasePath }) => {
      const realDispatcher = await createLiveReviewedDispatcher({
        workspacesRoot, workspaceRepoRoot, runId, scenario: 'happy'
      });
      const dispatcher = wrapWithCallTracking(realDispatcher);
      const { orchestrator, close } = buildLiveOrchestrator({
        databasePath, workspacesRoot, workspaceRepoRoot, dispatcher
      });
      try {
        const result = await orchestrator.dispatch({ runId, tenant: TENANT });
        expect(result.run.currentStep).toBe('implementation.human_review');

        // Implementer + reviewer both called at least once.
        const implCalls = dispatcher.calls.filter((c) => c.role === 'implementer');
        const revCalls = dispatcher.calls.filter((c) => c.role === 'reviewer');
        expect(implCalls.length).toBeGreaterThanOrEqual(1);
        expect(revCalls.length).toBeGreaterThanOrEqual(1);

        // Reviewer called in read_only mode.
        for (const rev of revCalls) {
          expect(rev.toolPolicyMode).toBe('read_only');
        }

        // Inspect persisted state with a fresh db handle.
        const db = createSqliteDatabase({ path: databasePath });
        const repos = createDrizzleDomainRepositories(db);
        try {
          const steps = await repos.runSteps.listByRun(runId);
          const buildStep = steps.find((s) => s.step === 'implementation.build');
          expect(buildStep).toBeDefined();
          const checkpoint = buildStep?.checkpointResult as Record<string, unknown> | null;
          expect(checkpoint).toMatchObject({
            kind: 'convergence_review',
            step: 'implementation.build',
            outcome: 'converged'
          });
          // No reviewer feedback persisted (satisfied).
          const feedback = await repos.feedback.listByRun(runId);
          expect(feedback).toHaveLength(0);
        } finally {
          db.close();
        }
      } finally {
        close();
      }
    });
  }, 120_000);

  it('forced stall reaches max rounds and pauses at implementation.awaiting_input', async () => {
    await withLiveScenario('ac-live-stall', async ({ runId, workspacesRoot, workspaceRepoRoot, databasePath }) => {
      const realDispatcher = await createLiveReviewedDispatcher({
        workspacesRoot, workspaceRepoRoot, runId, scenario: 'stall'
      });
      const dispatcher = wrapWithCallTracking(realDispatcher);
      // maxRounds=1: after one implementer+reviewer round, stalls if reviewer returned findings.
      const { orchestrator, close } = buildLiveOrchestrator({
        databasePath, workspacesRoot, workspaceRepoRoot, dispatcher,
        getPolicy: () => ({ maxRounds: 1 })
      });
      try {
        const result = await orchestrator.dispatch({ runId, tenant: TENANT });
        expect(result.run.currentStep).toBe('implementation.awaiting_input');
        expect(getRunStepDefinition(result.run.currentStep)?.waitingOn).toBe('human');
        expect(result.runStep.step).toBe('implementation.awaiting_input');

        const implCalls = dispatcher.calls.filter((c) => c.role === 'implementer');
        const revCalls = dispatcher.calls.filter((c) => c.role === 'reviewer');
        expect(implCalls.length).toBeGreaterThanOrEqual(1);
        expect(revCalls.length).toBeGreaterThanOrEqual(1);
        expect(implCalls.length).toBeLessThanOrEqual(3);

        const db = createSqliteDatabase({ path: databasePath });
        const repos = createDrizzleDomainRepositories(db);
        try {
          const feedback = await repos.feedback.listByRun(runId);
          expect(feedback.length).toBeGreaterThanOrEqual(1);
          for (const fb of feedback) {
            expect(fb.title).toBe('Stall test finding');
            expect(fb.tenant).toBe(TENANT);
          }

          const steps = await repos.runSteps.listByRun(runId);
          const buildStep = steps.find((s) => s.step === 'implementation.build');
          expect(buildStep).toBeDefined();
          const checkpoint = buildStep?.checkpointResult as Record<string, unknown> | null;
          expect(checkpoint?.['kind']).toBe('convergence_review');
          expect(['max_rounds', 'oscillation']).toContain(checkpoint?.['outcome']);
        } finally {
          db.close();
        }
      } finally {
        close();
      }
    });
  }, 120_000);

  it('full-ladder descends both altitudes, captures layout checkpoint, and advances (live, depth: layout)', async () => {
    await withLiveScenario('ac-live-ladder', async ({ runId, workspacesRoot, workspaceRepoRoot, databasePath }) => {
      // Uses the same hello.txt happy-path scenario at depth: layout so the real dispatcher
      // drives both the layout altitude (implementer writes + reviewer reviews) and the build
      // altitude. The .txt file is outside the TypeScript altitude-contract validator scope so
      // the early-altitude validator passes, the checkpoint ref is captured, and build converges.
      const realDispatcher = await createLiveReviewedDispatcher({
        workspacesRoot, workspaceRepoRoot, runId, scenario: 'happy'
      });
      const dispatcher = wrapWithCallTracking(realDispatcher);
      const { orchestrator, close } = buildLiveOrchestrator({
        databasePath, workspacesRoot, workspaceRepoRoot, dispatcher,
        depth: 'layout'
      });
      try {
        const result = await orchestrator.dispatch({ runId, tenant: TENANT });
        expect(result.run.currentStep).toBe('implementation.human_review');

        // Both altitudes were visited — real dispatcher received altitude context for each.
        const altitudesSeen = new Set(
          dispatcher.calls
            .map((c) => c.reviewContext?.altitudeContext?.altitude)
            .filter(Boolean)
        );
        expect(altitudesSeen.has('layout')).toBe(true);
        expect(altitudesSeen.has('build')).toBe(true);

        // Layout checkpoint ref was captured between altitudes.
        const db = createSqliteDatabase({ path: databasePath });
        const repos = createDrizzleDomainRepositories(db);
        try {
          const steps = await repos.runSteps.listByRun(runId);
          const buildStep = steps.find((s) => s.step === 'implementation.build');
          expect(buildStep).toBeDefined();
          const checkpoint = buildStep?.checkpointResult as Record<string, unknown> | null;
          expect(checkpoint).toMatchObject({
            kind: 'convergence_review',
            outcome: 'converged',
            depth: 'layout',
            currentAltitude: 'build'
          });
          const acceptedCheckpoints = checkpoint?.['acceptedCheckpoints'] as Array<Record<string, unknown>>;
          expect(acceptedCheckpoints).toHaveLength(1);
          expect(acceptedCheckpoints[0]?.['altitude']).toBe('layout');
          expect(typeof acceptedCheckpoints[0]?.['ref']).toBe('string');
          expect(typeof acceptedCheckpoints[0]?.['commitSha']).toBe('string');
        } finally {
          db.close();
        }
      } finally {
        close();
      }
    });
  }, 180_000);

  it('captured logs do not contain API key secrets', () => {
    // This assertion runs after the two dispatch tests have executed and
    // any console.warn calls have been captured. It verifies that none of
    // the API key values leaked into the warning log output.
    for (const secret of secretValues) {
      for (const warning of capturedWarnings) {
        expect(warning).not.toContain(secret);
      }
    }
  });
});
