import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { RunnerEvent, RunnerStepCheckpointEvent } from '@autocatalyst/api-contract';
import {
  DefaultControlPlaneService,
  DefaultOrchestrator,
  InMemoryRunEventBus,
  OrchestratorError,
  RunDispatchQueue,
  createExecutionContextResolver,
  createExecutionRunUnitOfWork,
  hardcodedDevelopmentPrincipal,
  permissivePolicyDecisionPoint,
  type RunUnitOfWork
} from '@autocatalyst/core';
import {
  StubRunner,
  createExecutionEntryPoint,
  createExecutionMaterializer,
  provisionWorkspace
} from '@autocatalyst/execution';
import {
  DrizzleConversationIngressRepository,
  createDrizzleDomainRepositories,
  createSqliteDatabase,
  migrateSqliteDatabase
} from '@autocatalyst/persistence';

const execFileAsync = promisify(execFile);

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
  it('delivers a run_state_transition event end-to-end through subscribeRunEvents after a tick', async () => {
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
        unitOfWork
      });
      const controlPlane = new DefaultControlPlaneService({
        orchestrator,
        runs: domainRepos.runs,
        runSteps: domainRepos.runSteps,
        events: eventBus,
        policy: permissivePolicyDecisionPoint
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

      const capturedEvents: RunnerEvent[] = [];

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
        materialize: (context) => materializer.materialize(context)
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
        unitOfWork
      });
      const controlPlane = new DefaultControlPlaneService({
        orchestrator,
        runs: domainRepos.runs,
        runSteps: domainRepos.runSteps,
        events: eventBus,
        policy: permissivePolicyDecisionPoint
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

      const capturedEvents: RunnerEvent[] = [];

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
        materialize: (context) => materializer.materialize(context)
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
        unitOfWork
      });
      const controlPlane = new DefaultControlPlaneService({
        orchestrator,
        runs: domainRepos.runs,
        runSteps: domainRepos.runSteps,
        events: eventBus,
        policy: permissivePolicyDecisionPoint
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
});
