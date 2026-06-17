import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { RunnerStepCheckpointEvent } from '@autocatalyst/api-contract';
import {
  DefaultControlPlaneService,
  DefaultIssueReferenceIntakeResolver,
  DefaultOrchestrator,
  InMemoryRunEventBus,
  OrchestratorError,
  RunDispatchQueue,
  SpecAuthoringServiceDependencies,
  StaticIssueTrackerRegistry,
  buildSpecAuthorContext,
  createExecutionContextResolver,
  createExecutionRunUnitOfWork,
  hardcodedDevelopmentPrincipal,
  permissivePolicyDecisionPoint,
  type RunUnitOfWork,
  type RunWorkInput
} from '@autocatalyst/core';
import {
  StubRunner,
  createExecutionEntryPoint,
  createExecutionMaterializer,
  createStepResultContractRegistry,
  provisionWorkspace,
  registerSpecAuthorResultContract,
  type ExecutionBoundaryEvent
} from '@autocatalyst/execution';
import {
  DrizzleConversationIngressRepository,
  createDrizzleDomainRepositories,
  createSqliteDatabase,
  migrateSqliteDatabase
} from '@autocatalyst/persistence';

import { loadSpecAuthorPromptInput, SpecAuthoringContextLoadError } from './spec-authoring-context-loader.js';
import { createSpecAuthoringHarness } from './spec-authoring-harness.spec-helper.js';

const execFileAsync = promisify(execFile);

// Empty registry — will return tracker_not_found for issue_reference submissions,
// but passes cleanly for explicit workKind (free_form) submissions used in these tests.
function makePassThroughIntakeResolver(): DefaultIssueReferenceIntakeResolver {
  const trackerRegistry = new StaticIssueTrackerRegistry({});
  return new DefaultIssueReferenceIntakeResolver({ registry: trackerRegistry });
}

async function git(args: readonly string[], cwd?: string): Promise<string> {
  const result = await execFileAsync('git', args as string[], { cwd, windowsHide: true });
  return result.stdout.trim();
}

const owner = {
  id: 'principal_dev_human',
  kind: 'human' as const,
  tenantId: 'tenant_dev',
  displayName: 'Development Principal'
};

async function waitForRunStep(
  read: () => Promise<{ readonly currentStep: string; readonly waitingOn?: string }>,
  step: string,
  timeoutMs = 5000
): Promise<{ readonly currentStep: string; readonly waitingOn?: string }> {
  const deadline = Date.now() + timeoutMs;
  let last: { readonly currentStep: string; readonly waitingOn?: string } | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (last.currentStep === step) return last;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for run step '${step}'. Last step: ${last?.currentStep ?? 'unknown'}`);
}

// ---------------------------------------------------------------------------
// Owner information used across all suites
// ---------------------------------------------------------------------------

describe('duplicate-active-run conflict via real SQLite orchestrator', () => {
  it('createRun returns active_run_conflict with topic and existing run details when a non-terminal run already exists on the topic', async () => {
    const database = createSqliteDatabase({ path: ':memory:' });
    await migrateSqliteDatabase(database);
    try {
      const domainRepos = createDrizzleDomainRepositories(database);
      const conversationIngress = new DrizzleConversationIngressRepository(database);
      const eventBus = new InMemoryRunEventBus();
      const dispatchQueue = new RunDispatchQueue({ maxConcurrent: 2 });
      const orchestrator = new DefaultOrchestrator({
        runs: domainRepos.runs,
        conversationIngress,
        events: eventBus,
        dispatchQueue
      });

      const project = await domainRepos.projects.create({
        owner,
        tenant: 'tenant_dev',
        displayName: 'Conflict Project',
        repoUrl: 'https://example.test',
        hostRepository: { provider: 'github', owner: 'test', name: 'repo' },
        workspaceRootOverride: null,
        issueTrackerSetting: null,
        codeHostSetting: null,
        credentialRefs: []
      });
      const conv = await domainRepos.conversations.create({
        projectId: project.id,
        owner,
        tenant: 'tenant_dev',
        identity: 'conflict-test',
        activeTopicId: null
      });
      const topic = await domainRepos.topics.create({
        conversationId: conv.id,
        owner,
        tenant: 'tenant_dev',
        title: 'Topic for conflict test',
        kind: 'main'
      });

      const first = await orchestrator.createRun({
        topicId: topic.id,
        owner,
        tenant: 'tenant_dev',
        workKind: 'feature'
      });
      expect(first.run.terminal).toBe(false);

      let caught: unknown;
      try {
        await orchestrator.createRun({
          topicId: topic.id,
          owner,
          tenant: 'tenant_dev',
          workKind: 'feature'
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(OrchestratorError);
      const err = caught as OrchestratorError;
      expect(err.code).toBe('active_run_conflict');
      const details = err.details as { topicId: string; existingRunId: string | null };
      expect(details.topicId).toBe(topic.id);
      expect(details.existingRunId).toBe(first.run.id);

      // First run must remain unchanged
      const unchanged = await domainRepos.runs.findById(first.run.id);
      expect(unchanged?.id).toBe(first.run.id);
      expect(unchanged?.terminal).toBe(false);
    } finally {
      database.close();
    }
  });
});

describe('control-plane-service integration (SQLite + real orchestrator + real event bus)', () => {
  it('delivers a run_state_transition event end-to-end through subscribeRunEvents after fallback tick', async () => {
    const database = createSqliteDatabase({ path: ':memory:' });
    await migrateSqliteDatabase(database);
    try {
      const domainRepos = createDrizzleDomainRepositories(database);
      const conversationIngress = new DrizzleConversationIngressRepository(database);
      const eventBus = new InMemoryRunEventBus();
      const dispatchQueue = new RunDispatchQueue({ maxConcurrent: 2 });
      const unitOfWork: RunUnitOfWork = {
        run: async () => ({ directive: 'advance' })
      };
      const orchestrator = new DefaultOrchestrator({
        runs: domainRepos.runs,
        conversationIngress,
        events: eventBus,
        dispatchQueue,
        unitOfWork,
        autoDispatch: { enabled: false }
      });
      const controlPlane = new DefaultControlPlaneService({
        orchestrator,
        runs: domainRepos.runs,
        runSteps: domainRepos.runSteps,
        events: eventBus,
        policy: permissivePolicyDecisionPoint,
        artifacts: domainRepos.artifacts,
        feedback: domainRepos.feedback,
        runWorkspaceMetadata: domainRepos.runWorkspaceMetadata,
        workspaceFilesystem: { writeFile: vi.fn(), readFile: vi.fn().mockResolvedValue('') },
        feedbackLifecycle: { feedback: domainRepos.feedback, ids: () => 'id', clock: () => new Date().toISOString() },
        projects: domainRepos.projects,
        issueReferenceIntakeResolver: makePassThroughIntakeResolver()
      });

      // Create a project so the conversation ingress has a valid project.
      const project = await domainRepos.projects.create({
        owner,
        tenant: 'tenant_dev',
        displayName: 'Integration Project',
        repoUrl: 'https://example.test',
        hostRepository: { provider: 'github', owner: 'test', name: 'repo' },
        workspaceRootOverride: null,
        issueTrackerSetting: null,
        codeHostSetting: null,
        credentialRefs: []
      });

      // Step 1: create conversation with first run (publishes a 'start' event but no subscriber yet).
      const createResp = await controlPlane.createConversationWithFirstRun({
        principal: hardcodedDevelopmentPrincipal,
        tenant: 'tenant_dev',
        request: {
          projectId: project.id,
          identity: 'test',
          topic: { title: 'T' },
          submission: { kind: 'free_form', body: 'hello', workKind: 'feature' }
        }
      });

      // Step 2: subscribe AFTER creation (live bus does not replay).
      const subscription = await controlPlane.subscribeRunEvents({
        principal: hardcodedDevelopmentPrincipal,
        tenant: 'tenant_dev',
        runId: createResp.run.id
      });

      try {
        // Step 3: trigger a NEW transition concurrently with reading the iterator.
        const tickPromise = Promise.resolve().then(() =>
          controlPlane.tick({
            principal: hardcodedDevelopmentPrincipal,
            tenant: 'tenant_dev',
            runId: createResp.run.id
          })
        );

        const iter = subscription.events[Symbol.asyncIterator]();
        const next = await iter.next();
        await tickPromise;

        expect(next.done).toBe(false);
        const event = next.value;
        expect(event.type).toBe('run_state_transition');
        expect(event.runId).toBe(createResp.run.id);
        expect(event.tenant).toBe('tenant_dev');
        expect(event.transition.directive).toBe('advance');
      } finally {
        subscription.close();
      }
    } finally {
      database.close();
    }
  });
});

describe('control-plane-service auto-dispatch integration (SQLite + real orchestrator + spec gate)', () => {
  it('auto-advances a feature run from service create to spec.human_review without tick', async () => {
    const database = createSqliteDatabase({ path: ':memory:' });
    await migrateSqliteDatabase(database);
    try {
      const domainRepos = createDrizzleDomainRepositories(database);
      const conversationIngress = new DrizzleConversationIngressRepository(database);
      const eventBus = new InMemoryRunEventBus();
      const dispatchQueue = new RunDispatchQueue({ maxConcurrent: 2 });
      const authoredSpecContents = '---\ncreated: 2026-06-12\nlast_updated: 2026-06-12\nstatus: draft\nspecced_by: autocatalyst\n---\n# Service auto dispatch\n';
      const unitRun = vi.fn(async ({ run }: RunWorkInput) => {
        if (run.currentStep === 'intake') {
          return { directive: 'advance' as const };
        }
        if (run.currentStep === 'spec.author') {
          return {
            directive: 'advance' as const,
            result: {
              kind: 'feature_spec',
              slug: 'service-auto-dispatch',
              relativePath: 'context-human/specs/feature-service-auto-dispatch.md',
              frontmatter: {
                created: '2026-06-12',
                last_updated: '2026-06-12',
                status: 'draft',
                specced_by: 'autocatalyst'
              },
              body: '# Service auto dispatch\n'
            }
          };
        }
        return { directive: 'advance' as const };
      });
      const orchestrator = new DefaultOrchestrator({
        runs: domainRepos.runs,
        conversationIngress,
        events: eventBus,
        dispatchQueue,
        unitOfWork: { run: unitRun },
        specAuthoringDependencies: {
          artifacts: domainRepos.artifacts,
          filesystem: {
            writeFile: vi.fn().mockResolvedValue(undefined),
            readFile: vi.fn().mockResolvedValue(authoredSpecContents)
          },
          git: { commitFiles: vi.fn().mockResolvedValue({}) }
        },
        resolveWorkspaceContext: vi.fn().mockResolvedValue({
          workspaceRepoRoot: '/tmp/service-auto-dispatch',
          workspaceHandle: 'ws_service_auto_dispatch'
        }),
        runWorkspaceMetadata: domainRepos.runWorkspaceMetadata
      });
      const controlPlane = new DefaultControlPlaneService({
        orchestrator,
        runs: domainRepos.runs,
        runSteps: domainRepos.runSteps,
        events: eventBus,
        policy: permissivePolicyDecisionPoint,
        artifacts: domainRepos.artifacts,
        feedback: domainRepos.feedback,
        runWorkspaceMetadata: domainRepos.runWorkspaceMetadata,
        workspaceFilesystem: { writeFile: vi.fn(), readFile: vi.fn().mockResolvedValue('') },
        feedbackLifecycle: { feedback: domainRepos.feedback, ids: () => 'id', clock: () => new Date().toISOString() },
        projects: domainRepos.projects,
        issueReferenceIntakeResolver: makePassThroughIntakeResolver()
      });

      const project = await domainRepos.projects.create({
        owner,
        tenant: 'tenant_dev',
        displayName: 'Auto-Dispatch Project',
        repoUrl: 'https://example.test',
        hostRepository: { provider: 'github', owner: 'test', name: 'repo' },
        workspaceRootOverride: null,
        issueTrackerSetting: null,
        codeHostSetting: null,
        credentialRefs: []
      });

      const createResp = await controlPlane.createConversationWithFirstRun({
        principal: hardcodedDevelopmentPrincipal,
        tenant: 'tenant_dev',
        request: {
          projectId: project.id,
          identity: 'service-auto-dispatch-test',
          topic: { title: 'Service Auto Dispatch Topic' },
          submission: { kind: 'free_form', body: 'auto dispatch me', workKind: 'feature' }
        }
      });

      const runId = createResp.run.id;

      const finalRun = await waitForRunStep(
        async () => {
          const run = await domainRepos.runs.findById(runId);
          if (run === null) throw new Error(`Run '${runId}' not found`);
          return run as { readonly currentStep: string; readonly waitingOn?: string };
        },
        'spec.human_review'
      );

      expect(finalRun.currentStep).toBe('spec.human_review');
      expect(unitRun).toHaveBeenCalledTimes(1);

      const listedRuns = await controlPlane.listRuns({
        principal: hardcodedDevelopmentPrincipal,
        tenant: 'tenant_dev'
      });
      const listedRun = listedRuns.runs.find((r) => r.id === runId);
      expect(listedRun).toBeDefined();
      expect(listedRun?.currentStep).toBe('spec.human_review');
      expect((listedRun as { waitingOn?: string } | undefined)?.waitingOn).toBe('human');
    } finally {
      database.close();
    }
  }, 10000);
});

describe('execution boundary integration (real StubRunner through two-root workspace)', () => {
  let tempRoot: string;
  let upstreamPath: string;
  let reposRoot: string;
  let workspacesRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'autocatalyst-boundary-'));
    upstreamPath = path.join(tempRoot, 'upstream.git');
    const sourcePath = path.join(tempRoot, 'source');
    reposRoot = path.join(tempRoot, 'repos');
    workspacesRoot = path.join(tempRoot, 'workspaces');

    await git(['init', '--bare', upstreamPath]);
    await git(['clone', upstreamPath, sourcePath]);
    await git(['checkout', '-b', 'main'], sourcePath);
    await git(['config', 'user.name', 'Autocatalyst Test'], sourcePath);
    await git(['config', 'user.email', 'test@example.invalid'], sourcePath);
    await fs.writeFile(path.join(sourcePath, 'README.md'), '# Integration Test\n', 'utf8');
    await git(['add', 'README.md'], sourcePath);
    await git(['commit', '-m', 'initial commit'], sourcePath);
    await git(['push', '-u', 'origin', 'main'], sourcePath);
    await git(['symbolic-ref', 'HEAD', 'refs/heads/main'], upstreamPath);

    await fs.mkdir(reposRoot, { recursive: true });
    await fs.mkdir(workspacesRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('dispatches a feature run through the full execution boundary and advances to the next step', async () => {
    const database = createSqliteDatabase({ path: ':memory:' });
    await migrateSqliteDatabase(database);
    try {
      const domainRepos = createDrizzleDomainRepositories(database);
      const conversationIngress = new DrizzleConversationIngressRepository(database);

      // Create a project pointing at the local bare git repo.
      // Use file:// URL so repoUrl passes the z.string().url() validation while
      // still being a valid git remote that provisionWorkspace can clone.
      const upstreamUrl = `file://${upstreamPath}`;
      const project = await domainRepos.projects.create({
        owner,
        tenant: 'tenant_dev',
        displayName: 'Boundary Integration Project',
        repoUrl: upstreamUrl,
        hostRepository: { provider: 'git', owner: 'acme', name: 'widgets', url: upstreamUrl },
        workspaceRootOverride: null,
        issueTrackerSetting: null,
        codeHostSetting: null,
        credentialRefs: []
      });

      const capturedEvents: ExecutionBoundaryEvent[] = [];

      const contextResolver = createExecutionContextResolver({
        workspace: (input) => ({
          project,
          roots: { reposRoot, workspacesRoot },
          topicSlug: 'integration-test',
          shortRunId: input.run.id.slice(0, 8),
          defaultBranch: 'main'
        }),
        secretsAvailable: false
      });

      const materializer = createExecutionMaterializer({
        capabilities: { shellAvailable: false, lspAvailable: false }
      });

      const entryPoint = createExecutionEntryPoint({
        runner: new StubRunner(),
        materialize: (context) => materializer.materialize(context),
        resultValidation: { mode: 'none' }
      });

      const unitOfWork = createExecutionRunUnitOfWork({
        execute: entryPoint,
        resolveContext: (input) => contextResolver.resolve(input),
        onEvent: (event) => { capturedEvents.push(event); }
      });

      const eventBus = new InMemoryRunEventBus();
      const dispatchQueue = new RunDispatchQueue({ maxConcurrent: 2 });
      const orchestrator = new DefaultOrchestrator({
        runs: domainRepos.runs,
        conversationIngress,
        events: eventBus,
        dispatchQueue,
        unitOfWork,
        autoDispatch: { enabled: false }
      });
      const controlPlane = new DefaultControlPlaneService({
        orchestrator,
        runs: domainRepos.runs,
        runSteps: domainRepos.runSteps,
        events: eventBus,
        policy: permissivePolicyDecisionPoint,
        artifacts: domainRepos.artifacts,
        feedback: domainRepos.feedback,
        runWorkspaceMetadata: domainRepos.runWorkspaceMetadata,
        workspaceFilesystem: { writeFile: vi.fn(), readFile: vi.fn().mockResolvedValue('') },
        feedbackLifecycle: { feedback: domainRepos.feedback, ids: () => 'id', clock: () => new Date().toISOString() },
        projects: domainRepos.projects,
        issueReferenceIntakeResolver: makePassThroughIntakeResolver()
      });

      // Create conversation + first run
      const createResp = await controlPlane.createConversationWithFirstRun({
        principal: hardcodedDevelopmentPrincipal,
        tenant: 'tenant_dev',
        request: {
          projectId: project.id,
          identity: 'boundary-test',
          topic: { title: 'Boundary Integration Topic' },
          submission: { kind: 'free_form', body: 'build something', workKind: 'feature' }
        }
      });

      // Tick to execute the run through the full boundary
      await controlPlane.tick({
        principal: hardcodedDevelopmentPrincipal,
        tenant: 'tenant_dev',
        runId: createResp.run.id
      });

      // Assert exactly 4 events in the right order
      expect(capturedEvents).toHaveLength(4);
      expect(capturedEvents.map((e) => e.type)).toEqual([
        'runner_progress',
        'runner_assistant_turn',
        'runner_step_checkpoint',
        'runner_terminal_result'
      ]);

      // Assert terminal event is 'advance'
      const terminalEvent = capturedEvents[3];
      expect(terminalEvent.type).toBe('runner_terminal_result');
      if (terminalEvent.type === 'runner_terminal_result') {
        expect(terminalEvent.result.directive).toBe('advance');
      }

      // Assert run was advanced (tick didn't throw and directive was advance)
      const runAfterTick = await domainRepos.runs.findById(createResp.run.id);
      expect(runAfterTick).not.toBeNull();
      // After 'advance', the run either moves to the next step or terminal — either way it advanced
      expect(runAfterTick?.terminal === true || runAfterTick?.currentStep !== createResp.run.currentStep).toBe(true);

      // Assert no second terminal event
      const terminalEvents = capturedEvents.filter((e) => e.type === 'runner_terminal_result');
      expect(terminalEvents).toHaveLength(1);

      // Assert checkpoint event reflects the two_roots workspace shape
      const checkpointEvent = capturedEvents[2] as RunnerStepCheckpointEvent;
      expect(checkpointEvent.checkpoint.data.workspaceShape).toBe('two_roots');
      expect(checkpointEvent.checkpoint.data.workspaceRootCount).toBe(2);
    } finally {
      database.close();
    }
  }, 30000);

  it('question workKind uses none workspace shape and does not call provisionWorkspace', async () => {
    const database = createSqliteDatabase({ path: ':memory:' });
    await migrateSqliteDatabase(database);
    try {
      const domainRepos = createDrizzleDomainRepositories(database);
      const conversationIngress = new DrizzleConversationIngressRepository(database);

      const upstreamUrl = `file://${upstreamPath}`;
      const project = await domainRepos.projects.create({
        owner,
        tenant: 'tenant_dev',
        displayName: 'Question Boundary Project',
        repoUrl: upstreamUrl,
        hostRepository: { provider: 'git', owner: 'acme', name: 'widgets', url: upstreamUrl },
        workspaceRootOverride: null,
        issueTrackerSetting: null,
        codeHostSetting: null,
        credentialRefs: []
      });

      // Injectable provisionWorkspace spy — should NOT be called for 'question' workKind
      let provisionCalled = false;
      const provisionSpy: typeof provisionWorkspace = async (_req) => {
        provisionCalled = true;
        throw new Error('provisionWorkspace should not be called for question workKind');
      };

      const capturedEvents: ExecutionBoundaryEvent[] = [];

      const contextResolver = createExecutionContextResolver({
        // For 'question' workKind, workspace input won't be used (shape: 'none')
        // We still provide a workspace function to be thorough
        workspace: (input) => ({
          project,
          roots: { reposRoot, workspacesRoot },
          topicSlug: 'question-test',
          shortRunId: input.run.id.slice(0, 8),
          defaultBranch: 'main'
        }),
        secretsAvailable: false
      });

      const materializer = createExecutionMaterializer({
        provisionWorkspace: provisionSpy,
        capabilities: { shellAvailable: false, lspAvailable: false }
      });

      const entryPoint = createExecutionEntryPoint({
        runner: new StubRunner(),
        materialize: (context) => materializer.materialize(context),
        resultValidation: { mode: 'none' }
      });

      const unitOfWork = createExecutionRunUnitOfWork({
        execute: entryPoint,
        resolveContext: (input) => contextResolver.resolve(input),
        onEvent: (event) => { capturedEvents.push(event); }
      });

      const eventBus = new InMemoryRunEventBus();
      const dispatchQueue = new RunDispatchQueue({ maxConcurrent: 2 });
      const orchestrator = new DefaultOrchestrator({
        runs: domainRepos.runs,
        conversationIngress,
        events: eventBus,
        dispatchQueue,
        unitOfWork,
        autoDispatch: { enabled: false }
      });
      const controlPlane = new DefaultControlPlaneService({
        orchestrator,
        runs: domainRepos.runs,
        runSteps: domainRepos.runSteps,
        events: eventBus,
        policy: permissivePolicyDecisionPoint,
        artifacts: domainRepos.artifacts,
        feedback: domainRepos.feedback,
        runWorkspaceMetadata: domainRepos.runWorkspaceMetadata,
        workspaceFilesystem: { writeFile: vi.fn(), readFile: vi.fn().mockResolvedValue('') },
        feedbackLifecycle: { feedback: domainRepos.feedback, ids: () => 'id', clock: () => new Date().toISOString() },
        projects: domainRepos.projects,
        issueReferenceIntakeResolver: makePassThroughIntakeResolver()
      });

      const createResp = await controlPlane.createConversationWithFirstRun({
        principal: hardcodedDevelopmentPrincipal,
        tenant: 'tenant_dev',
        request: {
          projectId: project.id,
          identity: 'question-boundary-test',
          topic: { title: 'Question Topic' },
          submission: { kind: 'free_form', body: 'what is the answer?', workKind: 'question' }
        }
      });

      await controlPlane.tick({
        principal: hardcodedDevelopmentPrincipal,
        tenant: 'tenant_dev',
        runId: createResp.run.id
      });

      // provisionWorkspace must NOT have been called
      expect(provisionCalled).toBe(false);

      // The checkpoint event must reflect shape: 'none'
      const checkpointEvent = capturedEvents.find((e) => e.type === 'runner_step_checkpoint') as RunnerStepCheckpointEvent | undefined;
      expect(checkpointEvent).toBeDefined();
      expect(checkpointEvent?.checkpoint.data.workspaceShape).toBe('none');
      expect(checkpointEvent?.checkpoint.data.workspaceRootCount).toBe(0);
    } finally {
      database.close();
    }
  }, 30000);

  it('StubRunner with result file and scratch_file validation yields advance with result', async () => {
    const scratchRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-scratch-'));
    try {
      const artifactSchema = z.object({ artifact: z.string() }).strict();

      const runner = new StubRunner({
        resultFile: { relativePath: 'result.json', value: { artifact: 'result.md' } }
      });

      const context = {
        run: { id: 'run_scratch_1', workKind: 'feature', currentStep: 'implement', tenant: 'tenant_1' },
        task: { prompt: 'Do something', inputs: {} },
        workspaceIntent: { shape: 'none' as const },
        secretBindings: [],
        toolPolicy: { allowedTools: [], workspaceScope: 'declared_workspace' as const },
        skills: { requested: [] },
        capabilityRequirements: {
          shell: { kind: 'bash' as const, required: false },
          paths: { canonicalWorkspacePaths: false },
          lsp: { requested: false }
        }
      };

      const entryPoint = createExecutionEntryPoint({
        runner,
        materialize: async () => ({
          context,
          workspace: { shape: 'scratch_only' as const, scratchRoot, workspaceRoots: [scratchRoot] },
          environment: { variables: {}, secretVariableNames: [] },
          toolPolicy: { allowedTools: [], workspaceRoots: [scratchRoot] },
          skills: { requested: [] },
          capabilities: {
            shell: { kind: 'bash' as const, available: false },
            paths: { scratchRoot },
            lsp: { requested: false, available: false }
          }
        }),
        resultValidation: {
          mode: 'scratch_file',
          schemaId: 'artifact-result.v1',
          schema: artifactSchema,
          resultFile: 'result.json'
        }
      });

      const unitOfWork = createExecutionRunUnitOfWork({
        execute: entryPoint,
        resolveContext: async () => context,
        onEvent: () => {}
      });

      const input: RunWorkInput = {
        runId: 'run_scratch_1',
        run: {
          id: 'run_scratch_1',
          topicId: 'topic_scratch_1',
          owner: { id: 'user_1', kind: 'human', tenantId: 'tenant_1', displayName: 'Test User' },
          tenant: 'tenant_1',
          workKind: 'feature',
          currentStep: 'implement',
          terminal: false,
          createdAt: '2026-06-09T00:00:00.000Z',
          updatedAt: '2026-06-09T00:00:00.000Z'
        },
        tenant: 'tenant_1'
      };

      const result = await unitOfWork.run(input);

      expect(result).toEqual({ directive: 'advance', result: { artifact: 'result.md' } });
    } finally {
      await fs.rm(scratchRoot, { recursive: true, force: true });
    }
  }, 10000);

  it('StubRunner with malformed result file and scratch_file validation yields synthesized fail', async () => {
    const scratchRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-scratch-'));
    try {
      const artifactSchema = z.object({ artifact: z.string() }).strict();

      // artifact is a number (invalid — schema expects string)
      const runner = new StubRunner({
        resultFile: { relativePath: 'result.json', value: { artifact: 123 } }
      });

      const context = {
        run: { id: 'run_scratch_2', workKind: 'feature', currentStep: 'implement', tenant: 'tenant_1' },
        task: { prompt: 'Do something', inputs: {} },
        workspaceIntent: { shape: 'none' as const },
        secretBindings: [],
        toolPolicy: { allowedTools: [], workspaceScope: 'declared_workspace' as const },
        skills: { requested: [] },
        capabilityRequirements: {
          shell: { kind: 'bash' as const, required: false },
          paths: { canonicalWorkspacePaths: false },
          lsp: { requested: false }
        }
      };

      const entryPoint = createExecutionEntryPoint({
        runner,
        materialize: async () => ({
          context,
          workspace: { shape: 'scratch_only' as const, scratchRoot, workspaceRoots: [scratchRoot] },
          environment: { variables: {}, secretVariableNames: [] },
          toolPolicy: { allowedTools: [], workspaceRoots: [scratchRoot] },
          skills: { requested: [] },
          capabilities: {
            shell: { kind: 'bash' as const, available: false },
            paths: { scratchRoot },
            lsp: { requested: false, available: false }
          }
        }),
        resultValidation: {
          mode: 'scratch_file',
          schemaId: 'artifact-result.v1',
          schema: artifactSchema,
          resultFile: 'result.json',
          maxCorrectionAttempts: 0
        }
      });

      const unitOfWork = createExecutionRunUnitOfWork({
        execute: entryPoint,
        resolveContext: async () => context,
        onEvent: () => {}
      });

      const input: RunWorkInput = {
        runId: 'run_scratch_2',
        run: {
          id: 'run_scratch_2',
          topicId: 'topic_scratch_2',
          owner: { id: 'user_1', kind: 'human', tenantId: 'tenant_1', displayName: 'Test User' },
          tenant: 'tenant_1',
          workKind: 'feature',
          currentStep: 'implement',
          terminal: false,
          createdAt: '2026-06-09T00:00:00.000Z',
          updatedAt: '2026-06-09T00:00:00.000Z'
        },
        tenant: 'tenant_1'
      };

      const result = await unitOfWork.run(input);

      expect(result).toEqual({ directive: 'fail', reason: 'Execution failed: schema_validation_failed' });
    } finally {
      await fs.rm(scratchRoot, { recursive: true, force: true });
    }
  }, 10000);
});

// ---------------------------------------------------------------------------
// Spec-authoring end-to-end proof through real contract
// ---------------------------------------------------------------------------
//
// These tests drive a full feature run from conversation creation through the
// spec.author step using a real SQLite database, real git fixture, and a
// contract-aware harness Runner that writes a step-result.json to scratch.
// They assert:
//  - Success: prompt has mm:planning, run reaches spec.human_review, artifact exists
//  - Malformed: run is terminal, no spec artifact
// ---------------------------------------------------------------------------

describe('spec-authoring end-to-end through real contract (SQLite + real git + harness runner)', () => {
  let tempRoot: string;
  let upstreamPath: string;
  let reposRoot: string;
  let workspacesRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-spec-e2e-'));
    upstreamPath = path.join(tempRoot, 'upstream.git');
    const sourcePath = path.join(tempRoot, 'source');
    reposRoot = path.join(tempRoot, 'repos');
    workspacesRoot = path.join(tempRoot, 'workspaces');

    await git(['init', '--bare', upstreamPath]);
    await git(['clone', upstreamPath, sourcePath]);
    await git(['checkout', '-b', 'main'], sourcePath);
    await git(['config', 'user.name', 'Autocatalyst Test'], sourcePath);
    await git(['config', 'user.email', 'test@example.invalid'], sourcePath);
    await fs.writeFile(path.join(sourcePath, 'README.md'), '# Spec E2E Test\n', 'utf8');
    await git(['add', 'README.md'], sourcePath);
    await git(['commit', '-m', 'initial commit'], sourcePath);
    await git(['push', '-u', 'origin', 'main'], sourcePath);
    await git(['symbolic-ref', 'HEAD', 'refs/heads/main'], upstreamPath);

    await fs.mkdir(reposRoot, { recursive: true });
    await fs.mkdir(workspacesRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('success: prompt has mm:planning, run reaches spec.human_review, spec artifact is readable', async () => {
    const database = createSqliteDatabase({ path: ':memory:' });
    await migrateSqliteDatabase(database);
    try {
      const domainRepos = createDrizzleDomainRepositories(database);
      const conversationIngress = new DrizzleConversationIngressRepository(database);

      const upstreamUrl = `file://${upstreamPath}`;
      const project = await domainRepos.projects.create({
        owner,
        tenant: 'tenant_dev',
        displayName: 'Spec E2E Project',
        repoUrl: upstreamUrl,
        hostRepository: { provider: 'git', owner: 'acme', name: 'widgets', url: upstreamUrl },
        workspaceRootOverride: null,
        issueTrackerSetting: null,
        codeHostSetting: null,
        credentialRefs: []
      });

      // Seed the run directly at spec.author to exercise single-step dispatch with real context.
      const now = new Date().toISOString();
      const seedResult = await conversationIngress.createConversationTopicMessageAndRun({
        conversation: {
          projectId: project.id,
          owner,
          tenant: 'tenant_dev',
          identity: 'spec-e2e-success',
          activeTopicId: null
        },
        topic: {
          owner,
          tenant: 'tenant_dev',
          title: 'Spec E2E Success Topic',
          kind: 'main'
        },
        message: {
          owner,
          tenant: 'tenant_dev',
          author: owner,
          direction: 'inbound',
          body: 'author a feature spec'
        },
        run: {
          owner,
          tenant: 'tenant_dev',
          workKind: 'feature',
          currentStep: 'spec.author',
          terminal: false
        },
        runStep: {
          phase: 'spec',
          step: 'spec.author',
          role: 'none',
          startedAt: now,
          endedAt: null,
          durationMs: null
        }
      });
      const runId = seedResult.run.id;

      const harness = createSpecAuthoringHarness('conformant');

      // In-memory filesystem shared between specAuthoringDependencies and
      // DefaultControlPlaneService.workspaceFilesystem so reads return what was written.
      const inMemoryFiles = new Map<string, string>();
      const sharedFilesystem = {
        writeFile: async (input: { workspaceRepoRoot: string; relativePath: string; contents: string }): Promise<void> => {
          inMemoryFiles.set(`${input.workspaceRepoRoot}::${input.relativePath}`, input.contents);
        },
        readFile: async (input: { workspaceRepoRoot: string; relativePath: string }): Promise<string> => {
          const key = `${input.workspaceRepoRoot}::${input.relativePath}`;
          const value = inMemoryFiles.get(key);
          if (value === undefined) throw new Error(`File not found in in-memory filesystem: ${input.relativePath}`);
          return value;
        }
      };

      // Registry holding runId → repoRoot so resolveWorkspaceContext can return it.
      const workspaceRootRegistry = new Map<string, string>();

      const specContractRegistry = registerSpecAuthorResultContract(
        createStepResultContractRegistry()
      );

      const materializer = createExecutionMaterializer({
        capabilities: { shellAvailable: false, lspAvailable: false }
      });

      const entryPoint = createExecutionEntryPoint({
        runner: harness.runner,
        materialize: async (context) => {
          const env = await materializer.materialize(context);
          // Register repoRoot for two_roots workspace so resolveWorkspaceContext can find it
          if (env.workspace.shape === 'two_roots') {
            workspaceRootRegistry.set(context.run.id, env.workspace.repoRoot);
          }
          return env;
        },
        resultValidation: {
          mode: 'scratch_file',
          contractRegistry: specContractRegistry,
          step: 'spec.author',
          schemaId: 'autocatalyst.spec_author.v1'
        }
      });

      const unitOfWork = createExecutionRunUnitOfWork({
        execute: entryPoint,
        resolveContext: async (workInput) => {
          // Build spec-author context when at spec.author step
          let specAuthorPrompt: string | undefined;
          let specAuthorTaskInputs: Record<string, unknown> | undefined;
          if (
            workInput.run.currentStep === 'spec.author' &&
            (workInput.run.workKind === 'feature' || workInput.run.workKind === 'enhancement')
          ) {
            try {
              const promptInput = await loadSpecAuthorPromptInput({
                runId: workInput.runId,
                tenantId: workInput.tenant,
                repositories: domainRepos
              });
              const ctx = buildSpecAuthorContext(promptInput);
              specAuthorPrompt = ctx.prompt;
              specAuthorTaskInputs = ctx.taskInputs;
            } catch (error) {
              if (error instanceof SpecAuthoringContextLoadError) {
                throw new Error(`spec_authoring_context_load_failed: ${error.code}`);
              }
              throw error;
            }
          }

          return createExecutionContextResolver({
            workspace: (input) => ({
              project,
              roots: { reposRoot, workspacesRoot },
              topicSlug: 'spec-e2e-test',
              shortRunId: input.run.id.slice(0, 8),
              defaultBranch: 'main'
            }),
            secretsAvailable: false,
            ...(specAuthorPrompt !== undefined ? { prompt: specAuthorPrompt } : {}),
            ...(specAuthorTaskInputs !== undefined ? { taskInputs: specAuthorTaskInputs } : {})
          }).resolve(workInput);
        },
        onEvent: () => {}
      });

      const eventBus = new InMemoryRunEventBus();
      const dispatchQueue = new RunDispatchQueue({ maxConcurrent: 2 });

      const specAuthoringDependencies: SpecAuthoringServiceDependencies = {
        artifacts: domainRepos.artifacts,
        filesystem: sharedFilesystem,
        git: { commitFiles: vi.fn().mockResolvedValue({}) },
        clock: () => new Date().toISOString()
      };

      const orchestrator = new DefaultOrchestrator({
        runs: domainRepos.runs,
        conversationIngress,
        events: eventBus,
        dispatchQueue,
        unitOfWork,
        autoDispatch: { enabled: false },
        specAuthoringDependencies,
        resolveWorkspaceContext: async ({ runId: rId }) => {
          const repoRoot = workspaceRootRegistry.get(rId);
          if (repoRoot === undefined) throw new Error(`Workspace root not found for run '${rId}'`);
          return { workspaceRepoRoot: repoRoot, workspaceHandle: rId };
        },
        runWorkspaceMetadata: domainRepos.runWorkspaceMetadata
      });

      const controlPlane = new DefaultControlPlaneService({
        orchestrator,
        runs: domainRepos.runs,
        runSteps: domainRepos.runSteps,
        events: eventBus,
        policy: permissivePolicyDecisionPoint,
        artifacts: domainRepos.artifacts,
        feedback: domainRepos.feedback,
        runWorkspaceMetadata: domainRepos.runWorkspaceMetadata,
        workspaceFilesystem: sharedFilesystem,
        feedbackLifecycle: {
          feedback: domainRepos.feedback,
          ids: () => `id_${Math.random().toString(36).slice(2)}`,
          clock: () => new Date().toISOString()
        },
        projects: domainRepos.projects,
        issueReferenceIntakeResolver: makePassThroughIntakeResolver()
      });

      // Tick once — the run is already at spec.author, so this executes the spec authoring step
      await controlPlane.tick({
        principal: hardcodedDevelopmentPrincipal,
        tenant: 'tenant_dev',
        runId
      });

      // --- Assertions ---

      // Harness must have captured exactly one spec.author call
      expect(harness.records).toHaveLength(1);
      const record = harness.records[0]!;

      // Prompt must be the real spec-authoring prompt (not a placeholder)
      expect(record.prompt).toContain('mm:planning');
      expect(record.prompt).not.toContain('Complete the spec.author step.');

      // Task inputs must carry the spec author schema contract
      expect(record.taskInputs).toMatchObject({
        schemaId: 'autocatalyst.spec_author.v1',
        resultFile: 'step-result.json',
        outputContract: { expectedKind: 'feature_spec' }
      });

      // Run must be at spec.human_review and not terminal
      const run = await domainRepos.runs.findById(runId);
      expect(run).not.toBeNull();
      expect(run?.currentStep).toBe('spec.human_review');
      expect(run?.terminal).toBe(false);

      // Spec artifact must be readable via the service
      const spec = await controlPlane.getRunSpec({
        principal: hardcodedDevelopmentPrincipal,
        tenant: 'tenant_dev',
        runId
      });
      expect(spec.artifact.kind).toBe('feature_spec');
      expect(spec.artifact.location).toMatch(/^context-human\/specs\/feature-[a-z0-9-]+\.md$/u);
      expect(spec.markdown).toContain('status: draft');
      expect(spec.markdown).toContain('## Task list');
    } finally {
      database.close();
    }
  }, 60000);

  it('identity-stamping: spec advances even when model omits frontmatter.specced_by', async () => {
    const database = createSqliteDatabase({ path: ':memory:' });
    await migrateSqliteDatabase(database);
    try {
      const domainRepos = createDrizzleDomainRepositories(database);
      const conversationIngress = new DrizzleConversationIngressRepository(database);

      const upstreamUrl = `file://${upstreamPath}`;
      const project = await domainRepos.projects.create({
        owner,
        tenant: 'tenant_dev',
        displayName: 'Spec E2E Omitted specced_by Project',
        repoUrl: upstreamUrl,
        hostRepository: { provider: 'git', owner: 'acme', name: 'widgets', url: upstreamUrl },
        workspaceRootOverride: null,
        issueTrackerSetting: null,
        codeHostSetting: null,
        credentialRefs: []
      });

      const now = new Date().toISOString();
      const seedResult = await conversationIngress.createConversationTopicMessageAndRun({
        conversation: {
          projectId: project.id,
          owner,
          tenant: 'tenant_dev',
          identity: 'spec-e2e-omitted-specced-by',
          activeTopicId: null
        },
        topic: {
          owner,
          tenant: 'tenant_dev',
          title: 'Spec E2E Omitted specced_by Topic',
          kind: 'main'
        },
        message: {
          owner,
          tenant: 'tenant_dev',
          author: owner,
          direction: 'inbound',
          body: 'author a feature spec (omitted specced_by)'
        },
        run: {
          owner,
          tenant: 'tenant_dev',
          workKind: 'feature',
          currentStep: 'spec.author',
          terminal: false
        },
        runStep: {
          phase: 'spec',
          step: 'spec.author',
          role: 'none',
          startedAt: now,
          endedAt: null,
          durationMs: null
        }
      });
      const runId = seedResult.run.id;

      const harness = createSpecAuthoringHarness('omitted_specced_by');

      const inMemoryFiles = new Map<string, string>();
      const sharedFilesystem = {
        writeFile: async (input: { workspaceRepoRoot: string; relativePath: string; contents: string }): Promise<void> => {
          inMemoryFiles.set(`${input.workspaceRepoRoot}::${input.relativePath}`, input.contents);
        },
        readFile: async (input: { workspaceRepoRoot: string; relativePath: string }): Promise<string> => {
          const key = `${input.workspaceRepoRoot}::${input.relativePath}`;
          const value = inMemoryFiles.get(key);
          if (value === undefined) throw new Error(`File not found in in-memory filesystem: ${input.relativePath}`);
          return value;
        }
      };

      const workspaceRootRegistry = new Map<string, string>();

      const specContractRegistry = registerSpecAuthorResultContract(
        createStepResultContractRegistry()
      );

      const materializer = createExecutionMaterializer({
        capabilities: { shellAvailable: false, lspAvailable: false }
      });

      const entryPoint = createExecutionEntryPoint({
        runner: harness.runner,
        materialize: async (context) => {
          const env = await materializer.materialize(context);
          if (env.workspace.shape === 'two_roots') {
            workspaceRootRegistry.set(context.run.id, env.workspace.repoRoot);
          }
          return env;
        },
        resultValidation: {
          mode: 'scratch_file',
          contractRegistry: specContractRegistry,
          step: 'spec.author',
          schemaId: 'autocatalyst.spec_author.v1'
        }
      });

      const unitOfWork = createExecutionRunUnitOfWork({
        execute: entryPoint,
        resolveContext: async (workInput) => {
          let specAuthorPrompt: string | undefined;
          let specAuthorTaskInputs: Record<string, unknown> | undefined;
          if (
            workInput.run.currentStep === 'spec.author' &&
            (workInput.run.workKind === 'feature' || workInput.run.workKind === 'enhancement')
          ) {
            try {
              const promptInput = await loadSpecAuthorPromptInput({
                runId: workInput.runId,
                tenantId: workInput.tenant,
                repositories: domainRepos
              });
              const ctx = buildSpecAuthorContext(promptInput);
              specAuthorPrompt = ctx.prompt;
              specAuthorTaskInputs = ctx.taskInputs;
            } catch (error) {
              if (error instanceof SpecAuthoringContextLoadError) {
                throw new Error(`spec_authoring_context_load_failed: ${error.code}`);
              }
              throw error;
            }
          }

          return createExecutionContextResolver({
            workspace: (input) => ({
              project,
              roots: { reposRoot, workspacesRoot },
              topicSlug: 'spec-e2e-omitted-specced-by',
              shortRunId: input.run.id.slice(0, 8),
              defaultBranch: 'main'
            }),
            secretsAvailable: false,
            ...(specAuthorPrompt !== undefined ? { prompt: specAuthorPrompt } : {}),
            ...(specAuthorTaskInputs !== undefined ? { taskInputs: specAuthorTaskInputs } : {})
          }).resolve(workInput);
        },
        onEvent: () => {}
      });

      const eventBus = new InMemoryRunEventBus();
      const dispatchQueue = new RunDispatchQueue({ maxConcurrent: 2 });

      const specAuthoringDependencies: SpecAuthoringServiceDependencies = {
        artifacts: domainRepos.artifacts,
        filesystem: sharedFilesystem,
        git: { commitFiles: vi.fn().mockResolvedValue({}) },
        clock: () => new Date().toISOString()
      };

      const orchestrator = new DefaultOrchestrator({
        runs: domainRepos.runs,
        conversationIngress,
        events: eventBus,
        dispatchQueue,
        unitOfWork,
        autoDispatch: { enabled: false },
        specAuthoringDependencies,
        resolveWorkspaceContext: async ({ runId: rId }) => {
          const repoRoot = workspaceRootRegistry.get(rId);
          if (repoRoot === undefined) throw new Error(`Workspace root not found for run '${rId}'`);
          return { workspaceRepoRoot: repoRoot, workspaceHandle: rId };
        },
        runWorkspaceMetadata: domainRepos.runWorkspaceMetadata
      });

      const controlPlane = new DefaultControlPlaneService({
        orchestrator,
        runs: domainRepos.runs,
        runSteps: domainRepos.runSteps,
        events: eventBus,
        policy: permissivePolicyDecisionPoint,
        artifacts: domainRepos.artifacts,
        feedback: domainRepos.feedback,
        runWorkspaceMetadata: domainRepos.runWorkspaceMetadata,
        workspaceFilesystem: sharedFilesystem,
        feedbackLifecycle: {
          feedback: domainRepos.feedback,
          ids: () => `id_${Math.random().toString(36).slice(2)}`,
          clock: () => new Date().toISOString()
        },
        projects: domainRepos.projects,
        issueReferenceIntakeResolver: makePassThroughIntakeResolver()
      });

      await controlPlane.tick({
        principal: hardcodedDevelopmentPrincipal,
        tenant: 'tenant_dev',
        runId
      });

      const run = await domainRepos.runs.findById(runId);
      expect(run?.currentStep).toBe('spec.human_review');

      const spec = await controlPlane.getRunSpec({
        principal: hardcodedDevelopmentPrincipal,
        tenant: 'tenant_dev',
        runId
      });
      expect(spec.markdown).toContain('specced_by: autocatalyst');
    } finally {
      database.close();
    }
  }, 60000);

  it('identity-stamping: spec advances even when model writes invalid frontmatter.specced_by', async () => {
    const database = createSqliteDatabase({ path: ':memory:' });
    await migrateSqliteDatabase(database);
    try {
      const domainRepos = createDrizzleDomainRepositories(database);
      const conversationIngress = new DrizzleConversationIngressRepository(database);

      const upstreamUrl = `file://${upstreamPath}`;
      const project = await domainRepos.projects.create({
        owner,
        tenant: 'tenant_dev',
        displayName: 'Spec E2E Invalid specced_by Project',
        repoUrl: upstreamUrl,
        hostRepository: { provider: 'git', owner: 'acme', name: 'widgets', url: upstreamUrl },
        workspaceRootOverride: null,
        issueTrackerSetting: null,
        codeHostSetting: null,
        credentialRefs: []
      });

      const now = new Date().toISOString();
      const seedResult = await conversationIngress.createConversationTopicMessageAndRun({
        conversation: {
          projectId: project.id,
          owner,
          tenant: 'tenant_dev',
          identity: 'spec-e2e-invalid-specced-by',
          activeTopicId: null
        },
        topic: {
          owner,
          tenant: 'tenant_dev',
          title: 'Spec E2E Invalid specced_by Topic',
          kind: 'main'
        },
        message: {
          owner,
          tenant: 'tenant_dev',
          author: owner,
          direction: 'inbound',
          body: 'author a feature spec (invalid specced_by)'
        },
        run: {
          owner,
          tenant: 'tenant_dev',
          workKind: 'feature',
          currentStep: 'spec.author',
          terminal: false
        },
        runStep: {
          phase: 'spec',
          step: 'spec.author',
          role: 'none',
          startedAt: now,
          endedAt: null,
          durationMs: null
        }
      });
      const runId = seedResult.run.id;

      const harness = createSpecAuthoringHarness('invalid_specced_by');

      const inMemoryFiles = new Map<string, string>();
      const sharedFilesystem = {
        writeFile: async (input: { workspaceRepoRoot: string; relativePath: string; contents: string }): Promise<void> => {
          inMemoryFiles.set(`${input.workspaceRepoRoot}::${input.relativePath}`, input.contents);
        },
        readFile: async (input: { workspaceRepoRoot: string; relativePath: string }): Promise<string> => {
          const key = `${input.workspaceRepoRoot}::${input.relativePath}`;
          const value = inMemoryFiles.get(key);
          if (value === undefined) throw new Error(`File not found in in-memory filesystem: ${input.relativePath}`);
          return value;
        }
      };

      const workspaceRootRegistry = new Map<string, string>();

      const specContractRegistry = registerSpecAuthorResultContract(
        createStepResultContractRegistry()
      );

      const materializer = createExecutionMaterializer({
        capabilities: { shellAvailable: false, lspAvailable: false }
      });

      const entryPoint = createExecutionEntryPoint({
        runner: harness.runner,
        materialize: async (context) => {
          const env = await materializer.materialize(context);
          if (env.workspace.shape === 'two_roots') {
            workspaceRootRegistry.set(context.run.id, env.workspace.repoRoot);
          }
          return env;
        },
        resultValidation: {
          mode: 'scratch_file',
          contractRegistry: specContractRegistry,
          step: 'spec.author',
          schemaId: 'autocatalyst.spec_author.v1'
        }
      });

      const unitOfWork = createExecutionRunUnitOfWork({
        execute: entryPoint,
        resolveContext: async (workInput) => {
          let specAuthorPrompt: string | undefined;
          let specAuthorTaskInputs: Record<string, unknown> | undefined;
          if (
            workInput.run.currentStep === 'spec.author' &&
            (workInput.run.workKind === 'feature' || workInput.run.workKind === 'enhancement')
          ) {
            try {
              const promptInput = await loadSpecAuthorPromptInput({
                runId: workInput.runId,
                tenantId: workInput.tenant,
                repositories: domainRepos
              });
              const ctx = buildSpecAuthorContext(promptInput);
              specAuthorPrompt = ctx.prompt;
              specAuthorTaskInputs = ctx.taskInputs;
            } catch (error) {
              if (error instanceof SpecAuthoringContextLoadError) {
                throw new Error(`spec_authoring_context_load_failed: ${error.code}`);
              }
              throw error;
            }
          }

          return createExecutionContextResolver({
            workspace: (input) => ({
              project,
              roots: { reposRoot, workspacesRoot },
              topicSlug: 'spec-e2e-invalid-specced-by',
              shortRunId: input.run.id.slice(0, 8),
              defaultBranch: 'main'
            }),
            secretsAvailable: false,
            ...(specAuthorPrompt !== undefined ? { prompt: specAuthorPrompt } : {}),
            ...(specAuthorTaskInputs !== undefined ? { taskInputs: specAuthorTaskInputs } : {})
          }).resolve(workInput);
        },
        onEvent: () => {}
      });

      const eventBus = new InMemoryRunEventBus();
      const dispatchQueue = new RunDispatchQueue({ maxConcurrent: 2 });

      const specAuthoringDependencies: SpecAuthoringServiceDependencies = {
        artifacts: domainRepos.artifacts,
        filesystem: sharedFilesystem,
        git: { commitFiles: vi.fn().mockResolvedValue({}) },
        clock: () => new Date().toISOString()
      };

      const orchestrator = new DefaultOrchestrator({
        runs: domainRepos.runs,
        conversationIngress,
        events: eventBus,
        dispatchQueue,
        unitOfWork,
        autoDispatch: { enabled: false },
        specAuthoringDependencies,
        resolveWorkspaceContext: async ({ runId: rId }) => {
          const repoRoot = workspaceRootRegistry.get(rId);
          if (repoRoot === undefined) throw new Error(`Workspace root not found for run '${rId}'`);
          return { workspaceRepoRoot: repoRoot, workspaceHandle: rId };
        },
        runWorkspaceMetadata: domainRepos.runWorkspaceMetadata
      });

      const controlPlane = new DefaultControlPlaneService({
        orchestrator,
        runs: domainRepos.runs,
        runSteps: domainRepos.runSteps,
        events: eventBus,
        policy: permissivePolicyDecisionPoint,
        artifacts: domainRepos.artifacts,
        feedback: domainRepos.feedback,
        runWorkspaceMetadata: domainRepos.runWorkspaceMetadata,
        workspaceFilesystem: sharedFilesystem,
        feedbackLifecycle: {
          feedback: domainRepos.feedback,
          ids: () => `id_${Math.random().toString(36).slice(2)}`,
          clock: () => new Date().toISOString()
        },
        projects: domainRepos.projects,
        issueReferenceIntakeResolver: makePassThroughIntakeResolver()
      });

      await controlPlane.tick({
        principal: hardcodedDevelopmentPrincipal,
        tenant: 'tenant_dev',
        runId
      });

      const run = await domainRepos.runs.findById(runId);
      expect(run?.currentStep).toBe('spec.human_review');

      const spec = await controlPlane.getRunSpec({
        principal: hardcodedDevelopmentPrincipal,
        tenant: 'tenant_dev',
        runId
      });
      expect(spec.markdown).toContain('specced_by: autocatalyst');
      expect(spec.markdown).not.toContain('autocatalyst:mm:planning');
    } finally {
      database.close();
    }
  }, 60000);

  it('malformed: mismatched kind/path in step-result.json causes run to fail, no spec artifact', async () => {
    const database = createSqliteDatabase({ path: ':memory:' });
    await migrateSqliteDatabase(database);
    try {
      const domainRepos = createDrizzleDomainRepositories(database);
      const conversationIngress = new DrizzleConversationIngressRepository(database);

      const upstreamUrl = `file://${upstreamPath}`;
      const project = await domainRepos.projects.create({
        owner,
        tenant: 'tenant_dev',
        displayName: 'Spec E2E Malformed Project',
        repoUrl: upstreamUrl,
        hostRepository: { provider: 'git', owner: 'acme', name: 'widgets', url: upstreamUrl },
        workspaceRootOverride: null,
        issueTrackerSetting: null,
        codeHostSetting: null,
        credentialRefs: []
      });

      // Seed the run directly at spec.author (same pattern as the success test)
      const now = new Date().toISOString();
      const seedResult = await conversationIngress.createConversationTopicMessageAndRun({
        conversation: {
          projectId: project.id,
          owner,
          tenant: 'tenant_dev',
          identity: 'spec-e2e-malformed',
          activeTopicId: null
        },
        topic: {
          owner,
          tenant: 'tenant_dev',
          title: 'Spec E2E Malformed Topic',
          kind: 'main'
        },
        message: {
          owner,
          tenant: 'tenant_dev',
          author: owner,
          direction: 'inbound',
          body: 'author a feature spec (malformed)'
        },
        run: {
          owner,
          tenant: 'tenant_dev',
          workKind: 'feature',
          currentStep: 'spec.author',
          terminal: false
        },
        runStep: {
          phase: 'spec',
          step: 'spec.author',
          role: 'none',
          startedAt: now,
          endedAt: null,
          durationMs: null
        }
      });
      const runId = seedResult.run.id;

      const harness = createSpecAuthoringHarness('mismatched_path');

      const workspaceRootRegistry = new Map<string, string>();
      const specContractRegistry = registerSpecAuthorResultContract(
        createStepResultContractRegistry()
      );

      const materializer = createExecutionMaterializer({
        capabilities: { shellAvailable: false, lspAvailable: false }
      });

      const entryPoint = createExecutionEntryPoint({
        runner: harness.runner,
        materialize: async (context) => {
          const env = await materializer.materialize(context);
          if (env.workspace.shape === 'two_roots') {
            workspaceRootRegistry.set(context.run.id, env.workspace.repoRoot);
          }
          return env;
        },
        resultValidation: {
          mode: 'scratch_file',
          contractRegistry: specContractRegistry,
          step: 'spec.author',
          schemaId: 'autocatalyst.spec_author.v1'
        }
      });

      const unitOfWork = createExecutionRunUnitOfWork({
        execute: entryPoint,
        resolveContext: async (workInput) => {
          let specAuthorPrompt: string | undefined;
          let specAuthorTaskInputs: Record<string, unknown> | undefined;
          if (
            workInput.run.currentStep === 'spec.author' &&
            (workInput.run.workKind === 'feature' || workInput.run.workKind === 'enhancement')
          ) {
            try {
              const promptInput = await loadSpecAuthorPromptInput({
                runId: workInput.runId,
                tenantId: workInput.tenant,
                repositories: domainRepos
              });
              const ctx = buildSpecAuthorContext(promptInput);
              specAuthorPrompt = ctx.prompt;
              specAuthorTaskInputs = ctx.taskInputs;
            } catch (error) {
              if (error instanceof SpecAuthoringContextLoadError) {
                throw new Error(`spec_authoring_context_load_failed: ${error.code}`);
              }
              throw error;
            }
          }

          return createExecutionContextResolver({
            workspace: (input) => ({
              project,
              roots: { reposRoot, workspacesRoot },
              topicSlug: 'spec-e2e-malformed',
              shortRunId: input.run.id.slice(0, 8),
              defaultBranch: 'main'
            }),
            secretsAvailable: false,
            ...(specAuthorPrompt !== undefined ? { prompt: specAuthorPrompt } : {}),
            ...(specAuthorTaskInputs !== undefined ? { taskInputs: specAuthorTaskInputs } : {})
          }).resolve(workInput);
        },
        onEvent: () => {}
      });

      const eventBus = new InMemoryRunEventBus();
      const dispatchQueue = new RunDispatchQueue({ maxConcurrent: 2 });

      const specAuthoringDependencies: SpecAuthoringServiceDependencies = {
        artifacts: domainRepos.artifacts,
        filesystem: { writeFile: vi.fn(), readFile: vi.fn().mockResolvedValue('') },
        git: { commitFiles: vi.fn().mockResolvedValue({}) }
      };

      const orchestrator = new DefaultOrchestrator({
        runs: domainRepos.runs,
        conversationIngress,
        events: eventBus,
        dispatchQueue,
        unitOfWork,
        autoDispatch: { enabled: false },
        specAuthoringDependencies,
        resolveWorkspaceContext: async ({ runId: rId }) => {
          const repoRoot = workspaceRootRegistry.get(rId);
          if (repoRoot === undefined) throw new Error(`Workspace root not found for run '${rId}'`);
          return { workspaceRepoRoot: repoRoot, workspaceHandle: rId };
        },
        runWorkspaceMetadata: domainRepos.runWorkspaceMetadata
      });

      const controlPlane = new DefaultControlPlaneService({
        orchestrator,
        runs: domainRepos.runs,
        runSteps: domainRepos.runSteps,
        events: eventBus,
        policy: permissivePolicyDecisionPoint,
        artifacts: domainRepos.artifacts,
        feedback: domainRepos.feedback,
        runWorkspaceMetadata: domainRepos.runWorkspaceMetadata,
        workspaceFilesystem: { writeFile: vi.fn(), readFile: vi.fn().mockResolvedValue('') },
        feedbackLifecycle: {
          feedback: domainRepos.feedback,
          ids: () => `id_${Math.random().toString(36).slice(2)}`,
          clock: () => new Date().toISOString()
        },
        projects: domainRepos.projects,
        issueReferenceIntakeResolver: makePassThroughIntakeResolver()
      });

      // Single tick — harness writes mismatched JSON, schema validation fails → fail directive
      await controlPlane.tick({
        principal: hardcodedDevelopmentPrincipal,
        tenant: 'tenant_dev',
        runId
      });

      // --- Assertions ---

      // Harness was called (prompt was correct)
      expect(harness.records).toHaveLength(1);

      // Run must be terminal due to the fail directive from schema validation failure
      const run = await domainRepos.runs.findById(runId);
      expect(run).not.toBeNull();
      expect(run?.terminal).toBe(true);
      expect(run?.currentStep).not.toBe('spec.human_review');

      // No spec artifact should exist
      await expect(
        controlPlane.getRunSpec({
          principal: hardcodedDevelopmentPrincipal,
          tenant: 'tenant_dev',
          runId
        })
      ).rejects.toMatchObject({ code: 'not_found' });
    } finally {
      database.close();
    }
  }, 60000);

  it('regression: create → auto-dispatch through intake → spec.author → spec.human_review with real two-root workspace (idempotent provisioning)', async () => {
    const database = createSqliteDatabase({ path: ':memory:' });
    await migrateSqliteDatabase(database);
    try {
      const domainRepos = createDrizzleDomainRepositories(database);
      const conversationIngress = new DrizzleConversationIngressRepository(database);

      const upstreamUrl = `file://${upstreamPath}`;
      const project = await domainRepos.projects.create({
        owner,
        tenant: 'tenant_dev',
        displayName: 'Auto-Dispatch Regression Project',
        repoUrl: upstreamUrl,
        hostRepository: { provider: 'git', owner: 'acme', name: 'widgets', url: upstreamUrl },
        workspaceRootOverride: null,
        issueTrackerSetting: null,
        codeHostSetting: null,
        credentialRefs: []
      });

      const harness = createSpecAuthoringHarness('conformant');

      const inMemoryFiles = new Map<string, string>();
      const sharedFilesystem = {
        writeFile: async (input: { workspaceRepoRoot: string; relativePath: string; contents: string }): Promise<void> => {
          inMemoryFiles.set(`${input.workspaceRepoRoot}::${input.relativePath}`, input.contents);
        },
        readFile: async (input: { workspaceRepoRoot: string; relativePath: string }): Promise<string> => {
          const key = `${input.workspaceRepoRoot}::${input.relativePath}`;
          const value = inMemoryFiles.get(key);
          if (value === undefined) throw new Error(`File not found in in-memory filesystem: ${input.relativePath}`);
          return value;
        }
      };

      const workspaceRootRegistry = new Map<string, string>();
      const specContractRegistry = registerSpecAuthorResultContract(
        createStepResultContractRegistry()
      );
      const materializer = createExecutionMaterializer({
        capabilities: { shellAvailable: false, lspAvailable: false }
      });

      // Use a resolver so intake gets mode:'none' and spec.author gets scratch_file validation.
      const entryPoint = createExecutionEntryPoint({
        runner: harness.runner,
        materialize: async (context) => {
          const env = await materializer.materialize(context);
          if (env.workspace.shape === 'two_roots') {
            workspaceRootRegistry.set(context.run.id, env.workspace.repoRoot);
          }
          return env;
        },
        resultValidation: (input) => {
          if (input.context.run.currentStep === 'spec.author') {
            return {
              mode: 'scratch_file' as const,
              contractRegistry: specContractRegistry,
              step: 'spec.author',
              schemaId: 'autocatalyst.spec_author.v1'
            };
          }
          return { mode: 'none' as const };
        }
      });

      const unitOfWork = createExecutionRunUnitOfWork({
        execute: entryPoint,
        resolveContext: async (workInput) => {
          let specAuthorPrompt: string | undefined;
          let specAuthorTaskInputs: Record<string, unknown> | undefined;
          if (
            workInput.run.currentStep === 'spec.author' &&
            (workInput.run.workKind === 'feature' || workInput.run.workKind === 'enhancement')
          ) {
            try {
              const promptInput = await loadSpecAuthorPromptInput({
                runId: workInput.runId,
                tenantId: workInput.tenant,
                repositories: domainRepos
              });
              const ctx = buildSpecAuthorContext(promptInput);
              specAuthorPrompt = ctx.prompt;
              specAuthorTaskInputs = ctx.taskInputs;
            } catch (error) {
              if (error instanceof SpecAuthoringContextLoadError) {
                throw new Error(`spec_authoring_context_load_failed: ${error.code}`);
              }
              throw error;
            }
          }

          return createExecutionContextResolver({
            workspace: (input) => ({
              project,
              roots: { reposRoot, workspacesRoot },
              topicSlug: 'autodispatch-regression',
              shortRunId: input.run.id.slice(0, 8),
              defaultBranch: 'main'
            }),
            secretsAvailable: false,
            ...(specAuthorPrompt !== undefined ? { prompt: specAuthorPrompt } : {}),
            ...(specAuthorTaskInputs !== undefined ? { taskInputs: specAuthorTaskInputs } : {})
          }).resolve(workInput);
        },
        onEvent: () => {}
      });

      const eventBus = new InMemoryRunEventBus();
      const dispatchQueue = new RunDispatchQueue({ maxConcurrent: 2 });

      const specAuthoringDependencies: SpecAuthoringServiceDependencies = {
        artifacts: domainRepos.artifacts,
        filesystem: sharedFilesystem,
        git: { commitFiles: vi.fn().mockResolvedValue({}) },
        clock: () => new Date().toISOString()
      };

      const orchestrator = new DefaultOrchestrator({
        runs: domainRepos.runs,
        conversationIngress,
        events: eventBus,
        dispatchQueue,
        unitOfWork,
        // auto-dispatch enabled (default): run advances through intake → spec.author automatically
        specAuthoringDependencies,
        resolveWorkspaceContext: async ({ runId: rId }) => {
          const repoRoot = workspaceRootRegistry.get(rId);
          if (repoRoot === undefined) throw new Error(`Workspace root not found for run '${rId}'`);
          return { workspaceRepoRoot: repoRoot, workspaceHandle: rId };
        },
        runWorkspaceMetadata: domainRepos.runWorkspaceMetadata
      });

      const controlPlane = new DefaultControlPlaneService({
        orchestrator,
        runs: domainRepos.runs,
        runSteps: domainRepos.runSteps,
        events: eventBus,
        policy: permissivePolicyDecisionPoint,
        artifacts: domainRepos.artifacts,
        feedback: domainRepos.feedback,
        runWorkspaceMetadata: domainRepos.runWorkspaceMetadata,
        workspaceFilesystem: sharedFilesystem,
        feedbackLifecycle: {
          feedback: domainRepos.feedback,
          ids: () => `id_${Math.random().toString(36).slice(2)}`,
          clock: () => new Date().toISOString()
        },
        projects: domainRepos.projects,
        issueReferenceIntakeResolver: makePassThroughIntakeResolver()
      });

      // Normal create — starts at intake, auto-dispatch fires for each step
      const createResp = await controlPlane.createConversationWithFirstRun({
        principal: hardcodedDevelopmentPrincipal,
        tenant: 'tenant_dev',
        request: {
          projectId: project.id,
          identity: 'autodispatch-regression-test',
          topic: { title: 'Auto-Dispatch Regression Topic' },
          submission: { kind: 'free_form', body: 'author a feature spec via auto-dispatch', workKind: 'feature' }
        }
      });

      const runId = createResp.run.id;

      // Poll until spec.human_review — intake + spec.author dispatch in the background
      const finalRun = await waitForRunStep(
        async () => {
          const run = await domainRepos.runs.findById(runId);
          if (run === null) throw new Error(`Run '${runId}' not found`);
          return run as { readonly currentStep: string; readonly waitingOn?: string };
        },
        'spec.human_review',
        15000
      );

      expect(finalRun.currentStep).toBe('spec.human_review');

      // Harness must have handled exactly one spec.author step
      expect(harness.records).toHaveLength(1);
      const record = harness.records[0]!;
      expect(record.prompt).toContain('mm:planning');
      expect(record.prompt).not.toContain('Complete the spec.author step.');

      // Run must not be terminal
      const run = await domainRepos.runs.findById(runId);
      expect(run?.terminal).toBe(false);
      expect(run?.currentStep).toBe('spec.human_review');

      // Spec artifact must exist and be readable
      const spec = await controlPlane.getRunSpec({
        principal: hardcodedDevelopmentPrincipal,
        tenant: 'tenant_dev',
        runId
      });
      expect(spec.artifact.kind).toBe('feature_spec');
      expect(spec.artifact.location).toMatch(/^context-human\/specs\/feature-[a-z0-9-]+\.md$/u);
      expect(spec.markdown).toContain('status: draft');
    } finally {
      database.close();
    }
  }, 90000);
});
