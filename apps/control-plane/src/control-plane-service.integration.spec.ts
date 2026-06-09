import { describe, expect, it } from 'vitest';

import {
  DefaultControlPlaneService,
  DefaultOrchestrator,
  InMemoryRunEventBus,
  OrchestratorError,
  RunDispatchQueue,
  hardcodedDevelopmentPrincipal,
  permissivePolicyDecisionPoint,
  type RunUnitOfWork
} from '@autocatalyst/core';
import {
  DrizzleConversationIngressRepository,
  createDrizzleDomainRepositories,
  createSqliteDatabase,
  migrateSqliteDatabase
} from '@autocatalyst/persistence';

const owner = {
  id: 'principal_dev_human',
  kind: 'human' as const,
  tenantId: 'tenant_dev',
  displayName: 'Development Principal'
};

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
