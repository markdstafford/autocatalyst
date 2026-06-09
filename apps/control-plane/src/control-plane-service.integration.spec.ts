import { describe, expect, it } from 'vitest';

import {
  DefaultControlPlaneService,
  DefaultOrchestrator,
  InMemoryRunEventBus,
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
