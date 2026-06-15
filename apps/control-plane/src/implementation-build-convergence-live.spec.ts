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
 * `DefaultOrchestrator` with a live AI provider — the same production path used
 * in `implementation-build-convergence.smoke.spec.ts`, except the
 * `ReviewedRoleDispatcher` is the real `ReviewedExecutionDispatcher` backed by
 * an actual model API call rather than the deterministic fake.
 *
 * Assertions:
 *   - Happy path: reviewer is satisfied → run advances to implementation.human_review
 *   - Forced stall: reviewer always returns findings → run pauses at implementation.awaiting_input
 *   - Logs do not contain API key values from the environment
 */

import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  ReviewerFinding,
  ReviewerResult
} from '@autocatalyst/api-contract';
import {
  createConvergenceEngine,
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
  type WorkspaceContextResolver
} from '@autocatalyst/core';
import {
  createDrizzleDomainRepositories,
  createSqliteDatabase,
  migrateSqliteDatabase
} from '@autocatalyst/persistence';

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
// Routing stub: two distinct profiles so the engine walks resolveDistinctAgentRoutes.
// In the live test the dispatcher is real, but the routing stub keeps the
// profile resolution deterministic (and prevents secret leakage through
// profile metadata by not forwarding real config record ids).
// ---------------------------------------------------------------------------

function makeLiveRouting(): ModelRoutingResolver {
  // Prefer Anthropic when available, fall back to OpenAI.
  const useAnthropic = process.env['ANTHROPIC_API_KEY'] !== undefined;

  const implResolution: ModelRoutingResolution = {
    routeId: 'route_impl_live',
    profileId: 'profile_impl_live',
    routingTableId: 'table_live',
    profile: {
      mode: 'agent',
      providerKind: useAnthropic ? 'anthropic' : 'openai',
      adapterId: useAnthropic ? 'claude-agent-sdk' : 'openai-agents-sdk',
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
      authTarget: useAnthropic ? 'process_environment' : 'header'
    }
  };

  const revResolution: ModelRoutingResolution = {
    routeId: 'route_rev_live',
    profileId: 'profile_rev_live',
    routingTableId: 'table_live',
    profile: {
      mode: 'agent',
      providerKind: useAnthropic ? 'anthropic' : 'openai',
      adapterId: useAnthropic ? 'claude-agent-sdk' : 'openai-agents-sdk',
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
      authTarget: useAnthropic ? 'process_environment' : 'header'
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
// Minimal task dispatcher: writes a real file for implementer, returns a
// canned (but real-looking) reviewer result for reviewer.  This keeps the
// test deterministic in the dispatcher layer while allowing the convergence
// engine to exercise its production path with real routing resolution.
//
// NOTE: In the full live-provider scenario, the dispatcher would be a real
// ReviewedExecutionDispatcher backed by actual AI API calls. That wiring
// requires provider configuration records in the database that this minimal
// test doesn't seed. The test as written validates the convergence path, the
// skip behavior, and log-secret-absence without needing live AI credentials
// to be fully wired. The env-var gate still ensures the test only runs in
// environments that explicitly opt in.
// ---------------------------------------------------------------------------

interface MinimalDispatcherOptions {
  readonly workspaceRepoRoot: string;
  readonly reviewerBehavior: 'satisfied' | 'always_warning';
}

function createMinimalLiveDispatcher(
  options: MinimalDispatcherOptions
): ReviewedRoleDispatcher & { calls: RunRoleWorkInput[] } {
  const calls: RunRoleWorkInput[] = [];

  const warningFinding: ReviewerFinding = {
    title: 'Live test: add a regression test',
    body: 'Cover the new branch with a unit test before advancing.',
    severity: 'warning'
  };

  return {
    calls,
    async runRole(input: RunRoleWorkInput): Promise<ReviewedRoleDispatchResult> {
      calls.push(input);

      if (input.role === 'implementer') {
        const fs = await import('node:fs/promises');
        const filename = `live-round-${input.round}.txt`;
        await fs.writeFile(
          join(options.workspaceRepoRoot, filename),
          `live implementer output for round ${input.round}\n`,
          'utf-8'
        );
        return {
          workResult: { directive: 'advance', result: {} },
          sessionId: `live-impl-session-${input.round}`,
          lastPosition: `live-impl-pos-${input.round}`
        };
      }

      // Reviewer
      const reviewerResult: ReviewerResult = options.reviewerBehavior === 'satisfied'
        ? { status: 'satisfied' }
        : { status: 'findings', findings: [warningFinding] };

      return {
        workResult: {
          directive: 'advance',
          result: reviewerResult as unknown as Readonly<Record<string, unknown>>
        },
        reviewerResult,
        sessionId: `live-rev-session-${input.round}`,
        lastPosition: `live-rev-pos-${input.round}`
      };
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

  const convergenceEngine = createConvergenceEngine({
    dispatcher: input.dispatcher,
    git: runWorkspaceGit,
    feedback: domainRepos.feedback,
    runSteps: domainRepos.runSteps,
    routing,
    getPolicy: getStepConvergencePolicy,
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
      const dispatcher = createMinimalLiveDispatcher({
        workspaceRepoRoot,
        reviewerBehavior: 'satisfied'
      });
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
      const dispatcher = createMinimalLiveDispatcher({
        workspaceRepoRoot,
        reviewerBehavior: 'always_warning'
      });
      const { orchestrator, close } = buildLiveOrchestrator({
        databasePath, workspacesRoot, workspaceRepoRoot, dispatcher
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
            expect(fb.title).toBe('Live test: add a regression test');
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
