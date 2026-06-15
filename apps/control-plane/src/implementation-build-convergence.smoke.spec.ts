/**
 * Deterministic smoke test for the implementation.build convergence path.
 *
 * What this exercises end-to-end through PRODUCTION code paths:
 *   - DefaultOrchestrator.dispatch — selects the reviewed path for
 *     implementation.build (step has implementer+reviewer roles).
 *   - createConvergenceEngine — the REAL convergence engine drives the
 *     implementer/commit/reviewer loop, applies blocking-set rules, persists
 *     reviewer findings as Feedback, writes the convergence checkpoint to the
 *     RunStep, and emits the directive that the orchestrator applies.
 *   - createRunWorkspaceGitPort — REAL host git port: it shells out to `git`
 *     against a real temp workspace, verifies containment within the
 *     configured workspacesRoot, and produces real commits.
 *   - Real SQLite persistence via createDrizzleDomainRepositories: runs, run
 *     steps, feedback, run workspace metadata.
 *
 * The two faked seams (kept deterministic):
 *   - ReviewedRoleDispatcher: a deterministic fake that, for implementer
 *     calls, writes a real file into the temp workspace (so the host git port
 *     captures a real change) and returns advance; for reviewer calls returns
 *     either `satisfied` (happy path) or a fixed warning finding (stall path).
 *   - ModelRoutingResolver: an in-memory stub that returns two distinct
 *     profiles for implementer and reviewer — the engine still walks the
 *     production `resolveReviewedRoutes` code path and records routing.distinct.
 *
 * Assertions verify the run advances on the happy path, pauses with
 * waitingOn:human on the stall path, persists reviewer findings, and writes a
 * convergence_review checkpoint with the right shape.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import type {
  ImplementationAltitude,
  ReviewerFinding,
  ReviewerResult
} from '@autocatalyst/api-contract';
import {
  createConvergenceEngine,
  createLayeredConvergenceEngine,
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

const execFileAsync = promisify(execFile);

const TENANT = hardcodedDevelopmentPrincipal.tenantId;
const OWNER = hardcodedDevelopmentPrincipal;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function makeRouting(): ModelRoutingResolver {
  const implResolution: ModelRoutingResolution = {
    routeId: 'route_impl',
    profileId: 'profile_impl',
    routingTableId: 'table_test',
    profile: {
      mode: 'agent',
      providerKind: 'anthropic',
      adapterId: 'claude-agent-sdk',
      configurationRecordId: 'cfg_impl',
      profileName: 'impl-profile',
      model: { provider: 'anthropic', model: 'claude-sonnet-4' },
      inferenceSettings: {},
      endpoint: {},
      connectionMechanism: 'process_environment'
    },
    credentialReference: {
      required: false,
      authTarget: 'process_environment'
    }
  };
  const revResolution: ModelRoutingResolution = {
    routeId: 'route_rev',
    profileId: 'profile_rev',
    routingTableId: 'table_test',
    profile: {
      mode: 'agent',
      providerKind: 'openai',
      adapterId: 'openai-agents-sdk',
      configurationRecordId: 'cfg_rev',
      profileName: 'rev-profile',
      model: { provider: 'openai', model: 'gpt-4.1' },
      inferenceSettings: {},
      endpoint: {},
      connectionMechanism: 'fetch_transport'
    },
    credentialReference: {
      required: false,
      authTarget: 'header'
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

interface FakeDispatcherOptions {
  readonly workspaceRepoRoot: string;
  readonly reviewerBehavior: 'satisfied' | 'always_warning';
}

/**
 * Altitude-aware fake dispatcher for the layered convergence smoke tests.
 * Writes altitude-appropriate TypeScript declarations at each non-build altitude
 * and a real implementation at build altitude. The reviewer always returns
 * `satisfied` unless `reviewerBehavior` says otherwise.
 */
interface AltitudeFakeDispatcherOptions {
  readonly workspaceRepoRoot: string;
  readonly reviewerBehavior: 'satisfied' | 'always_warning';
  /** If set, writing this content at the specified altitude overrides the default content. */
  readonly overrideAtAltitude?: {
    readonly altitude: ImplementationAltitude;
    readonly filename: string;
    readonly content: string;
  };
}

function createAltitudeFakeReviewedRoleDispatcher(
  options: AltitudeFakeDispatcherOptions
): ReviewedRoleDispatcher & { calls: RunRoleWorkInput[] } {
  const calls: RunRoleWorkInput[] = [];

  const warningFinding: ReviewerFinding = {
    title: 'Add a regression test',
    body: 'Cover the new branch with a unit test before advancing.',
    severity: 'warning'
  };

  const altitudeContent: Record<ImplementationAltitude, { filename: string; content: string }> = {
    layout: {
      filename: 'src/widget.ts',
      content: 'export declare const widgetId: string;\n'
    },
    public_api: {
      filename: 'src/widget.ts',
      content: 'export declare function createWidget(name: string): string;\n'
    },
    private_api: {
      filename: 'src/internal.ts',
      content: 'export declare function internalHelper(): void;\n'
    },
    build: {
      filename: 'src/widget.ts',
      content: [
        'export const widgetId = "widget";',
        'export function createWidget(name: string): string { return name; }',
        ''
      ].join('\n')
    }
  };

  return {
    calls,
    async runRole(input: RunRoleWorkInput): Promise<ReviewedRoleDispatchResult> {
      calls.push(input);

      if (input.role === 'implementer') {
        const altitude = (input.reviewContext?.altitudeContext?.altitude ?? 'build') as ImplementationAltitude;
        const override = options.overrideAtAltitude;
        let fileInfo = altitudeContent[altitude];
        if (override !== undefined && override.altitude === altitude) {
          fileInfo = { filename: override.filename, content: override.content };
        }

        const fs = await import('node:fs/promises');
        const path = await import('node:path');
        const fullPath = path.join(options.workspaceRepoRoot, fileInfo.filename);
        const dir = path.dirname(fullPath);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(fullPath, fileInfo.content, 'utf-8');

        const dispositions = (input.reviewContext?.requiredDispositions ?? []).map((req) => ({
          feedbackId: req.feedbackId,
          disposition: 'fixed' as const,
          summary: `claimed fix in round ${input.round}`
        }));

        return {
          workResult: { directive: 'advance', result: {} },
          dispositions,
          sessionId: `impl-session-${altitude}-${input.round}`,
          lastPosition: `impl-pos-${altitude}-${input.round}`
        };
      }

      // Reviewer
      const reviewerResult: ReviewerResult = options.reviewerBehavior === 'satisfied'
        ? { status: 'satisfied' }
        : { status: 'findings', findings: [warningFinding] };

      return {
        workResult: { directive: 'advance', result: reviewerResult as unknown as Readonly<Record<string, unknown>> },
        reviewerResult,
        sessionId: `rev-session-${input.round}`,
        lastPosition: `rev-pos-${input.round}`
      };
    }
  };
}

/**
 * Deterministic ReviewedRoleDispatcher used in place of the production
 * ReviewedExecutionDispatcher. For implementer calls it WRITES a real file to
 * the workspace so the host git port records a real diff; for reviewer calls
 * it returns either `satisfied` or a fixed warning finding.
 */
function createFakeReviewedRoleDispatcher(options: FakeDispatcherOptions): ReviewedRoleDispatcher & { calls: RunRoleWorkInput[] } {
  const calls: RunRoleWorkInput[] = [];

  const warningFinding: ReviewerFinding = {
    title: 'Add a regression test',
    body: 'Cover the new branch with a unit test before advancing.',
    severity: 'warning'
  };

  return {
    calls,
    async runRole(input: RunRoleWorkInput): Promise<ReviewedRoleDispatchResult> {
      calls.push(input);

      if (input.role === 'implementer') {
        // Write a real file into the workspace so the host git port commits
        // an actual change for this round. The path varies by round to avoid
        // a "nothing to commit" path after the first iteration.
        const fs = await import('node:fs/promises');
        const filename = `round-${input.round}.txt`;
        await fs.writeFile(
          join(options.workspaceRepoRoot, filename),
          `implementer output for round ${input.round}\n`,
          'utf-8'
        );

        // In round 2+, the engine requires a disposition for every blocking finding
        // carried forward from the previous reviewer pass.
        const dispositions = (input.reviewContext?.requiredDispositions ?? []).map((req) => ({
          feedbackId: req.feedbackId,
          disposition: 'fixed' as const,
          summary: `claimed fix in round ${input.round}`
        }));

        return {
          workResult: { directive: 'advance', result: {} },
          dispositions,
          sessionId: `impl-session-${input.round}`,
          lastPosition: `impl-pos-${input.round}`
        };
      }

      // Reviewer
      const reviewerResult: ReviewerResult = options.reviewerBehavior === 'satisfied'
        ? { status: 'satisfied' }
        : { status: 'findings', findings: [warningFinding] };

      return {
        workResult: { directive: 'advance', result: reviewerResult as unknown as Readonly<Record<string, unknown>> },
        reviewerResult,
        sessionId: `rev-session-${input.round}`,
        lastPosition: `rev-pos-${input.round}`
      };
    }
  };
}

interface ScenarioHandles {
  readonly runId: string;
  readonly workspacesRoot: string;
  readonly workspaceRepoRoot: string;
  readonly databasePath: string;
}

async function seedRun(databasePath: string, workspaceRepoRoot: string): Promise<{ runId: string }> {
  const seedDb = createSqliteDatabase({ path: databasePath });
  await migrateSqliteDatabase(seedDb);
  const repos = createDrizzleDomainRepositories(seedDb);

  const project = await repos.projects.create({
    owner: OWNER,
    tenant: TENANT,
    displayName: 'Convergence Smoke Project',
    repoUrl: 'https://example.test/convergence-smoke',
    hostRepository: { provider: 'github', owner: 'test', name: 'convergence-smoke' },
    workspaceRootOverride: null,
    issueTrackerSetting: null,
    codeHostSetting: null,
    credentialRefs: []
  });
  const conversation = await repos.conversations.create({
    projectId: project.id,
    owner: OWNER,
    tenant: TENANT,
    identity: 'convergence-smoke-conv',
    activeTopicId: null
  });
  const topic = await repos.topics.create({
    conversationId: conversation.id,
    owner: OWNER,
    tenant: TENANT,
    title: 'Convergence smoke topic',
    kind: 'main'
  });

  // Use the chore workflow so we can position the run directly at
  // implementation.build without needing to seed a spec artifact.
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
    occurrence: { index: 0, attempt: 1, key: 'impl-build-0' }
  });

  await repos.runWorkspaceMetadata.upsert({
    runId: run.id,
    workspaceHandle: 'smoke-workspace',
    workspaceRepoRoot,
    createdAt: new Date().toISOString()
  });

  seedDb.close();
  return { runId: run.id };
}

async function withScenario(
  prefix: string,
  body: (handles: ScenarioHandles) => Promise<void>
): Promise<void> {
  await withTempDir(`${prefix}-ws-`, async (workspacesRoot) => {
    await withTempDir(`${prefix}-db-`, async (dbDir) => {
      const databasePath = join(dbDir, 'control-plane.sqlite');
      // Real git repo inside workspacesRoot — createRunWorkspaceGitPort
      // verifies the workspace is contained in workspacesRoot, so we create
      // a child directory and `git init` it.
      const workspaceRepoRoot = join(workspacesRoot, 'repo');
      const fs = await import('node:fs/promises');
      await fs.mkdir(workspaceRepoRoot, { recursive: true });
      await initGitRepo(workspaceRepoRoot);

      const { runId } = await seedRun(databasePath, workspaceRepoRoot);

      await body({ runId, workspacesRoot, workspaceRepoRoot, databasePath });
    });
  });
}

function buildOrchestrator(input: {
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
  const routing = makeRouting();

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
    workspaceHandle: 'smoke-workspace'
  });

  const orchestrator = new DefaultOrchestrator({
    runs: domainRepos.runs,
    conversationIngress: {
      // Not exercised by dispatch(), but the orchestrator requires it.
      createConversationTopicMessageAndRun: () => {
        throw new Error('not used in smoke test');
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

function buildLayeredOrchestrator(input: {
  readonly databasePath: string;
  readonly workspacesRoot: string;
  readonly workspaceRepoRoot: string;
  readonly dispatcher: ReviewedRoleDispatcher;
  readonly maxRounds?: number;
  readonly depth?: 'build_only' | 'layout' | 'public_api' | 'full';
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
  const routing = makeRouting();

  const convergenceEngine = createLayeredConvergenceEngine({
    dispatcher: input.dispatcher,
    git: runWorkspaceGit,
    feedback: domainRepos.feedback,
    runSteps: domainRepos.runSteps,
    routing,
    getPolicy: () => ({
      maxRounds: input.maxRounds ?? 2,
      depth: (input.depth ?? 'build_only') as 'build_only' | 'layout' | 'public_api' | 'full'
    }),
    logger: { warn: () => {} }
  });

  const resolveWorkspaceContext: WorkspaceContextResolver = async () => ({
    workspaceRepoRoot: input.workspaceRepoRoot,
    workspaceHandle: 'smoke-workspace'
  });

  const orchestrator = new DefaultOrchestrator({
    runs: domainRepos.runs,
    conversationIngress: {
      createConversationTopicMessageAndRun: () => {
        throw new Error('not used in smoke test');
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
// Tests
// ---------------------------------------------------------------------------

describe('implementation.build convergence — production-path smoke', () => {
  it('advances to implementation.human_review when reviewer is satisfied', async () => {
    await withScenario('ac-smoke-happy', async ({ runId, workspacesRoot, workspaceRepoRoot, databasePath }) => {
      const dispatcher = createFakeReviewedRoleDispatcher({
        workspaceRepoRoot,
        reviewerBehavior: 'satisfied'
      });
      const { orchestrator, close } = buildOrchestrator({
        databasePath, workspacesRoot, workspaceRepoRoot, dispatcher
      });
      try {
        const result = await orchestrator.dispatch({ runId, tenant: TENANT });
        expect(result.run.currentStep).toBe('implementation.human_review');

        // Exactly one implementer + one reviewer call.
        expect(dispatcher.calls.map((c) => c.role)).toEqual(['implementer', 'reviewer']);
        expect(dispatcher.calls.map((c) => c.round)).toEqual([1, 1]);

        // Session role/round/route info flowed through the dispatcher input.
        expect(dispatcher.calls[0]?.routeProfileId).toBe('profile_impl');
        expect(dispatcher.calls[1]?.routeProfileId).toBe('profile_rev');
        // Convergence engine enforces read-only tool policy on reviewer calls.
        expect(dispatcher.calls[1]?.toolPolicyMode).toBe('read_only');

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
          // routing.distinct populated by the real resolveReviewedRoutes seam.
          expect((checkpoint?.['routing'] as Record<string, unknown>)?.['distinct']).toBe(true);
          // Exactly one round recorded with implementer commit captured.
          const rounds = checkpoint?.['rounds'] as Array<Record<string, unknown>>;
          expect(rounds).toHaveLength(1);
          expect(rounds[0]?.['implementerCommitSha']).toMatch(/^[0-9a-f]{40}$/);
          expect(rounds[0]?.['outcome']).toBe('converged');

          // No reviewer feedback was persisted (status: satisfied).
          const feedback = await repos.feedback.listByRun(runId);
          expect(feedback).toHaveLength(0);
        } finally {
          db.close();
        }
      } finally {
        close();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // New layered convergence engine tests
  // ---------------------------------------------------------------------------

  it('full ladder happy path: all four altitudes converge, 3 checkpoint refs captured', async () => {
    await withScenario('ac-smoke-full-ladder', async ({ runId, workspacesRoot, workspaceRepoRoot, databasePath }) => {
      const dispatcher = createAltitudeFakeReviewedRoleDispatcher({
        workspaceRepoRoot,
        reviewerBehavior: 'satisfied'
      });
      const { orchestrator, close } = buildLayeredOrchestrator({
        databasePath, workspacesRoot, workspaceRepoRoot, dispatcher,
        depth: 'full', maxRounds: 2
      });
      try {
        const run = await orchestrator.dispatch({ runId, tenant: TENANT });
        expect(run.run.currentStep).toBe('implementation.human_review');

        // Convergence engine enforces read-only tool policy on all reviewer calls.
        const reviewerCalls = dispatcher.calls.filter((c) => c.role === 'reviewer');
        expect(reviewerCalls.length).toBeGreaterThan(0);
        expect(reviewerCalls.every((c) => c.toolPolicyMode === 'read_only')).toBe(true);

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
            depth: 'full',
            currentAltitude: 'build'
          });
          const acceptedCheckpoints = checkpoint?.['acceptedCheckpoints'] as Array<Record<string, unknown>>;
          expect(acceptedCheckpoints).toHaveLength(3);
          const altitudes = acceptedCheckpoints.map((c) => c['altitude']);
          expect(altitudes).toContain('layout');
          expect(altitudes).toContain('public_api');
          expect(altitudes).toContain('private_api');
        } finally {
          db.close();
        }
      } finally {
        close();
      }
    });
  });

  it('build drift: public_api export removed at build altitude triggers build_drift blocker', async () => {
    await withScenario('ac-smoke-drift', async ({ runId, workspacesRoot, workspaceRepoRoot, databasePath }) => {
      // At public_api: write createWidget export; at build: write a DIFFERENT file that does NOT
      // include createWidget, triggering build drift detection.
      const dispatcher = createAltitudeFakeReviewedRoleDispatcher({
        workspaceRepoRoot,
        reviewerBehavior: 'satisfied',
        overrideAtAltitude: {
          altitude: 'build',
          filename: 'src/widget.ts',
          // Deliberately omits createWidget — will trigger export_removed drift
          content: 'export function somethingElse(): void {}\n'
        }
      });
      const { orchestrator, close } = buildLayeredOrchestrator({
        databasePath, workspacesRoot, workspaceRepoRoot, dispatcher,
        depth: 'full', maxRounds: 1
      });
      try {
        const run = await orchestrator.dispatch({ runId, tenant: TENANT });
        expect(run.run.currentStep).toBe('implementation.awaiting_input');

        const db = createSqliteDatabase({ path: databasePath });
        const repos = createDrizzleDomainRepositories(db);
        try {
          const steps = await repos.runSteps.listByRun(runId);
          const buildStep = steps.find((s) => s.step === 'implementation.build');
          const checkpoint = buildStep?.checkpointResult as Record<string, unknown> | null;
          const rounds = checkpoint?.['rounds'] as Array<Record<string, unknown>>;
          // Find the build round
          const buildRound = rounds?.find((r) => r['altitude'] === 'build');
          expect(buildRound).toBeDefined();
          const findings = buildRound?.['findings'] as Array<Record<string, unknown>>;
          const driftFinding = findings?.find(
            (f) => f['source'] === 'build_drift' && f['blocking'] === true
          );
          expect(driftFinding).toBeDefined();
          expect(driftFinding?.['source']).toBe('build_drift');
          expect(driftFinding?.['blocking']).toBe(true);
          const titleLower = String(driftFinding?.['title'] ?? '').toLowerCase();
          expect(titleLower).toMatch(/build.*drift|drift.*build/i);
        } finally {
          db.close();
        }
      } finally {
        close();
      }
    });
  });

  it('early altitude contract violation: .spec.ts at layout blocks with altitude_contract finding', async () => {
    await withScenario('ac-smoke-contract-violation', async ({ runId, workspacesRoot, workspaceRepoRoot, databasePath }) => {
      // Override layout altitude to write a .spec.ts file — this triggers altitude_contract violation
      const dispatcher = createAltitudeFakeReviewedRoleDispatcher({
        workspaceRepoRoot,
        reviewerBehavior: 'satisfied',
        overrideAtAltitude: {
          altitude: 'layout',
          filename: 'src/widget.spec.ts',
          content: 'export const x = 1;\n'
        }
      });
      const { orchestrator, close } = buildLayeredOrchestrator({
        databasePath, workspacesRoot, workspaceRepoRoot, dispatcher,
        depth: 'full', maxRounds: 1
      });
      try {
        const run = await orchestrator.dispatch({ runId, tenant: TENANT });
        expect(run.run.currentStep).toBe('implementation.awaiting_input');

        const db = createSqliteDatabase({ path: databasePath });
        const repos = createDrizzleDomainRepositories(db);
        try {
          const steps = await repos.runSteps.listByRun(runId);
          const buildStep = steps.find((s) => s.step === 'implementation.build');
          const checkpoint = buildStep?.checkpointResult as Record<string, unknown> | null;
          // Must still be at layout altitude — no checkpoint was accepted
          expect(checkpoint?.['currentAltitude']).toBe('layout');
          const acceptedCheckpoints = checkpoint?.['acceptedCheckpoints'] as unknown[];
          expect(acceptedCheckpoints).toHaveLength(0);
          const rounds = checkpoint?.['rounds'] as Array<Record<string, unknown>>;
          const layoutRound = rounds?.[0];
          expect(layoutRound).toBeDefined();
          const findings = layoutRound?.['findings'] as Array<Record<string, unknown>>;
          const contractViolation = findings?.[0];
          expect(contractViolation?.['source']).toBe('altitude_contract');
          expect(contractViolation?.['blocking']).toBe(true);
          expect(contractViolation?.['category']).toBe('contract_violation');
        } finally {
          db.close();
        }
      } finally {
        close();
      }
    });
  });

  it('pauses at implementation.awaiting_input (waitingOn=human) on forced max-rounds stall', async () => {
    await withScenario('ac-smoke-stall', async ({ runId, workspacesRoot, workspaceRepoRoot, databasePath }) => {
      const dispatcher = createFakeReviewedRoleDispatcher({
        workspaceRepoRoot,
        reviewerBehavior: 'always_warning'
      });
      const { orchestrator, close } = buildOrchestrator({
        databasePath, workspacesRoot, workspaceRepoRoot, dispatcher
      });
      try {
        const result = await orchestrator.dispatch({ runId, tenant: TENANT });
        // implementation.build has needs_input -> implementation.awaiting_input.
        expect(result.run.currentStep).toBe('implementation.awaiting_input');
        // implementation.awaiting_input is waitingOn: human (derived from step catalog).
        expect(getRunStepDefinition(result.run.currentStep)?.waitingOn).toBe('human');
        expect(result.runStep.step).toBe('implementation.awaiting_input');

        // Reviewer was called for every implementer round; the engine ran the
        // full convergence policy (default 3 rounds).
        const implementerCalls = dispatcher.calls.filter((c) => c.role === 'implementer');
        const reviewerCalls = dispatcher.calls.filter((c) => c.role === 'reviewer');
        expect(implementerCalls.length).toBeGreaterThanOrEqual(1);
        expect(reviewerCalls.length).toBeGreaterThanOrEqual(1);
        // Engine should detect oscillation on round 2 (same blocking signature),
        // so we expect <= maxRounds (3) implementer calls.
        expect(implementerCalls.length).toBeLessThanOrEqual(3);

        const db = createSqliteDatabase({ path: databasePath });
        const repos = createDrizzleDomainRepositories(db);
        try {
          // Reviewer findings were persisted as Feedback for each reviewer round.
          const feedback = await repos.feedback.listByRun(runId);
          expect(feedback.length).toBeGreaterThanOrEqual(1);
          for (const fb of feedback) {
            expect(fb.title).toBe('Add a regression test');
            expect(fb.tenant).toBe(TENANT);
          }

          // The convergence checkpoint was persisted with a non-converged outcome.
          const steps = await repos.runSteps.listByRun(runId);
          const buildStep = steps.find((s) => s.step === 'implementation.build');
          expect(buildStep).toBeDefined();
          const checkpoint = buildStep?.checkpointResult as Record<string, unknown> | null;
          expect(checkpoint?.['kind']).toBe('convergence_review');
          expect(['max_rounds', 'oscillation']).toContain(checkpoint?.['outcome']);
          const openFeedbackIds = checkpoint?.['openFeedbackIds'] as readonly string[];
          expect(openFeedbackIds.length).toBeGreaterThanOrEqual(1);
        } finally {
          db.close();
        }
      } finally {
        close();
      }
    });
  });
});
