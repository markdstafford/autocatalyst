import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createConversationWithFirstRunResponseSchema,
  projectResponseSchema,
  runSchema,
  runStepListResponseSchema,
  runWorkflowResponseSchema,
  type RunWorkflowResponse
} from '@autocatalyst/api-contract';
import {
  DefaultControlPlaneService,
  DefaultIssueReferenceIntakeResolver,
  DefaultOrchestrator,
  InMemoryRunEventBus,
  RunDispatchQueue,
  StaticIssueTrackerRegistry,
  defaultRunWorkflowResolver,
  hardcodedDevelopmentPrincipal,
  permissivePolicyDecisionPoint,
  runWorkflowIds,
  runWorkflows,
  type ControlPlaneService,
  type DomainRepositories,
  type RunWorkflowDefinition,
  type RunWorkflowId,
  type RunWorkflowResolver
} from '@autocatalyst/core';
import {
  DrizzleConversationIngressRepository,
  createDrizzleDomainRepositories,
  createSqliteDatabase,
  migrateSqliteDatabase
} from '@autocatalyst/persistence';

import { readControlPlaneAppConfig } from './config.js';
import { FAKE_FIXTURE_PROJECT } from './fake/constants.js';
import { createControlPlaneServer, type ControlPlaneServerOptions } from './server.js';

const owner = { ...hardcodedDevelopmentPrincipal, kind: 'human' as const };
const tenant = owner.tenantId;
const headers = { authorization: 'Bearer fake-mode-token' };
const expectedPhases: Record<RunWorkflowId, readonly string[]> = {
  feature: ['spec:Spec', 'implementation:Implementation', 'pr:Pull request'],
  enhancement: ['spec:Spec', 'implementation:Implementation', 'pr:Pull request'],
  bug: ['spec:Triage', 'implementation:Implementation', 'pr:Pull request'],
  chore: ['implementation:Implementation', 'pr:Pull request'],
  file_issue: ['spec:Spec'],
  question: []
};

function expectedPath(workflow: RunWorkflowResponse): string[] {
  return workflow.steps.filter(({ onPath }) => onPath).map(({ id }) => id);
}

/** Test resolver: use the same tenant-scoped relationship for both topic-based lookups. */
function projectAwareResolver(
  repositories: () => Pick<DomainRepositories, 'topics' | 'conversations'>,
  select: (projectId: string, workKind: string) => RunWorkflowDefinition | undefined
): RunWorkflowResolver {
  return async (input) => {
    if (input.kind === 'new_conversation') {
      return select(input.projectId, input.workKind) ?? defaultRunWorkflowResolver(input);
    }
    const context = input.kind === 'existing_run' ? input.run : input;
    const { topics, conversations } = repositories();
    const topic = await topics.findById(context.topicId);
    if (topic === null || topic.tenant !== context.tenant) return null;
    const conversation = await conversations.findById(topic.conversationId);
    if (conversation === null || conversation.tenant !== context.tenant) return null;
    return select(conversation.projectId, context.workKind) ?? defaultRunWorkflowResolver(input);
  };
}

async function fakeHarness(workflowResolver?: RunWorkflowResolver) {
  const stateDir = await mkdtemp(join(tmpdir(), 'ac-workflow-'));
  const config = readControlPlaneAppConfig(['--fake-mode', '--fake-state-dir', stateDir], {});
  let service: ControlPlaneService | undefined;
  const options: ControlPlaneServerOptions = {
    ...config,
    autoDispatch: { enabled: false },
    onControlPlaneReady: (controlPlane) => { service = controlPlane; },
    ...(workflowResolver === undefined ? {} : { workflowResolver })
  };
  const app = await createControlPlaneServer(options);
  const project = await app.inject({
    method: 'POST', url: '/v1/projects', headers,
    payload: {
      displayName: FAKE_FIXTURE_PROJECT.displayName,
      repoUrl: FAKE_FIXTURE_PROJECT.repoUrl,
      hostRepository: FAKE_FIXTURE_PROJECT.hostRepository
    }
  });
  expect(project.statusCode, project.body).toBe(201);
  const projectId = projectResponseSchema.parse(project.json()).id;

  async function read(runId: string, suffix: string) {
    const response = await app.inject({ url: `/v1/runs/${runId}${suffix}`, headers });
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }

  return {
    projectId,
    databasePath: config.databasePath,
    async start(workKind: RunWorkflowId) {
      const response = await app.inject({
        method: 'POST', url: '/v1/conversations', headers,
        payload: {
          projectId, identity: `workflow-${workKind}`, topic: { title: `Work on a ${workKind}` },
          submission: { kind: 'free_form', body: `Scripted ${workKind} workflow test.`, workKind }
        }
      });
      expect(response.statusCode, response.body).toBe(201);
      return createConversationWithFirstRunResponseSchema.parse(response.json()).run;
    },
    async tick(runId: string) {
      expect(await service!.tick({ principal: owner, tenant, runId })).toEqual({ status: 'dispatched', runId });
    },
    async run(runId: string) { return runSchema.parse(await read(runId, '')); },
    async workflow(runId: string) { return runWorkflowResponseSchema.parse(await read(runId, '/workflow')); },
    async history(runId: string) { return runStepListResponseSchema.parse(await read(runId, '/steps')).steps; },
    async close() {
      await app.close();
      await rm(stateDir, { recursive: true, force: true });
    }
  };
}

describe('production workflow reads with scripted sessions', () => {
  it('reads all six built-ins and returns the same question definition at intake and done', async () => {
    const harness = await fakeHarness();
    try {
      for (const workKind of runWorkflowIds) {
        const run = await harness.start(workKind);
        expect(run.currentStep).toBe('intake');
        const body = await harness.workflow(run.id);
        expect(body.workflowId).toBe(workKind);
        expect(body.workKind).toBe(workKind);
        expect(expectedPath(body)).toEqual(runWorkflows[workKind].steps);
        expect(body.phases.map(({ id, label }) => `${id}:${label}`)).toEqual(expectedPhases[workKind]);

        if (workKind === 'question') {
          await harness.tick(run.id);
          expect((await harness.run(run.id)).currentStep).toBe('done');
          expect((await harness.history(run.id)).map(({ step }) => step)).toEqual(expectedPath(body));
          expect(await harness.workflow(run.id)).toEqual(body);
        }
      }
    } finally {
      await harness.close();
    }
  }, 20_000);

  it('runs features through spec review and bugs past Triage without a spec review gate', async () => {
    const harness = await fakeHarness();
    try {
      const feature = await harness.start('feature');
      const bug = await harness.start('bug');
      const featureWorkflow = await harness.workflow(feature.id);
      const bugWorkflow = await harness.workflow(bug.id);
      expect(featureWorkflow.steps.find(({ id }) => id === 'spec.human_review')).toMatchObject({ kind: 'gate', onPath: true });
      expect(bugWorkflow.steps.some(({ id }) => id === 'spec.human_review')).toBe(false);
      expect(bugWorkflow.phases[0]).toMatchObject({ id: 'spec', label: 'Triage' });

      await harness.tick(feature.id);
      expect((await harness.run(feature.id)).currentStep).toBe('spec.human_review');
      await harness.tick(bug.id);
      expect((await harness.run(bug.id)).currentStep).toBe('implementation.plan');
      for (const [run, workflow] of [[feature, featureWorkflow], [bug, bugWorkflow]] as const) {
        const history = (await harness.history(run.id)).map(({ step }) => step);
        expect(history).toEqual(expectedPath(workflow).slice(0, 3));
        expect(history.every(step => workflow.steps.some(({ id }) => id === step))).toBe(true);
      }
      const database = createSqliteDatabase({ path: harness.databasePath });
      try {
        const { artifacts } = createDrizzleDomainRepositories(database);
        expect(await artifacts.findByRunAndKind({ runId: bug.id, kind: 'bug_triage' }))
          .toMatchObject({ canonicalRecord: 'issue' });
      } finally {
        database.close();
      }
    } finally {
      await harness.close();
    }
  }, 25_000);

  it('selects a project workflow at creation and drives the returned override through implementation review', async () => {
    const override: RunWorkflowDefinition = {
      ...runWorkflows.feature,
      phases: [{ id: 'implementation', label: 'Delivery' }, { id: 'pr', label: 'Pull request' }],
      steps: runWorkflows.chore.steps,
      transitions: runWorkflows.chore.transitions
    };
    const resolver = vi.fn(projectAwareResolver(
      () => repositories,
      (project, kind) => project === projectId && kind === 'feature' ? override : undefined
    ));
    const harness = await fakeHarness(resolver);
    const projectId = harness.projectId;
    const database = createSqliteDatabase({ path: harness.databasePath });
    const repositories = createDrizzleDomainRepositories(database);
    try {
      const run = await harness.start('feature');
      expect(resolver).toHaveBeenNthCalledWith(1, { kind: 'new_conversation', workKind: 'feature', tenant, projectId });
      const body = await harness.workflow(run.id);
      expect(body.workflowId).toBe('feature');
      expect(body.phases.map(({ label }) => label)).toEqual(['Delivery', 'Pull request']);
      expect(expectedPath(body)).toEqual(override.steps);
      expect(body.steps.some(({ id }) => id.startsWith('spec.'))).toBe(false);
      expect(body.transitions.some(({ from, to }) => from.startsWith('spec.') || to.startsWith('spec.'))).toBe(false);
      expect(body.transitions).toContainEqual({ from: 'intake', directive: 'advance', to: 'implementation.plan' });

      await harness.tick(run.id);
      expect((await harness.run(run.id)).currentStep).toBe('implementation.build');
      await harness.tick(run.id);
      expect((await harness.run(run.id)).currentStep).toBe('implementation.human_review');
      expect((await harness.history(run.id)).map(({ step }) => step))
        .toEqual(expectedPath(body).slice(0, 5));
      expect(await harness.workflow(run.id)).toEqual(body);
    } finally {
      database.close();
      await harness.close();
    }
  }, 25_000);
});

it('uses topic context to select the same project definition for existing-topic start, read and advance', async () => {
  const database = createSqliteDatabase({ path: ':memory:' });
  try {
    await migrateSqliteDatabase(database);
    const repositories = createDrizzleDomainRepositories(database);

    async function seedTopic(name: string) {
      const project = await repositories.projects.create({
        tenant, owner, displayName: name, repoUrl: `https://github.com/fixture/${name}`,
        hostRepository: { provider: 'github', owner: 'fixture', name },
        workspaceRootOverride: null, issueTrackerSetting: null, codeHostSetting: null, credentialRefs: []
      });
      const conversation = await repositories.conversations.create({
        tenant, owner, projectId: project.id, identity: name, activeTopicId: null
      });
      const topic = await repositories.topics.create({ tenant, owner, title: name, conversationId: conversation.id, kind: 'main' });
      return { project, topic };
    }

    const alternate = await seedTopic('alternate');
    const standard = await seedTopic('standard');
    const override: RunWorkflowDefinition = {
      ...runWorkflows.feature,
      phases: [{ id: 'implementation', label: 'Build' }],
      steps: ['implementation.plan', 'implementation.build', 'done'],
      transitions: {
        'implementation.plan': { advance: 'implementation.build' },
        'implementation.build': { advance: 'done' }
      }
    };
    const workflowResolver = vi.fn(projectAwareResolver(
      () => repositories,
      (projectId) => projectId === alternate.project.id ? override : undefined
    ));

    const events = new InMemoryRunEventBus();
    const orchestrator = new DefaultOrchestrator({
      runs: repositories.runs, workflowResolver, events,
      conversationIngress: new DrizzleConversationIngressRepository(database),
      dispatchQueue: new RunDispatchQueue({ maxConcurrent: 1 }),
      autoDispatch: { enabled: false }
    });
    const service = new DefaultControlPlaneService({
      ...repositories, orchestrator, workflowResolver, events, policy: permissivePolicyDecisionPoint,
      workspaceFilesystem: { readFile: vi.fn(), writeFile: vi.fn() },
      feedbackLifecycle: { feedback: repositories.feedback, ids: () => 'feedback', clock: () => new Date().toISOString() },
      issueReferenceIntakeResolver: new DefaultIssueReferenceIntakeResolver({ registry: new StaticIssueTrackerRegistry({}) })
    });
    const definitions = [];
    for (const [context, definition] of [[alternate, override], [standard, runWorkflows.feature]] as const) {
      const start = { topicId: context.topic.id, owner, tenant, workKind: 'feature' };
      const { run, runStep } = await orchestrator.createRun(start);
      expect(workflowResolver).toHaveBeenLastCalledWith({
        kind: 'existing_topic', workKind: 'feature', tenant, topicId: context.topic.id
      });
      const persisted = await repositories.runs.findById(run.id);
      expect(persisted?.currentStep).toBe(definition.steps[0]);
      expect(runStep.step).toBe(persisted?.currentStep);
      const body = await service.getRunWorkflow({ runId: run.id, principal: owner });
      expect(workflowResolver).toHaveBeenLastCalledWith({ kind: 'existing_run', run: persisted });
      expect(body.workflowId).toBe('feature');
      expect(expectedPath(body)).toEqual(definition.steps);
      const advanced = await orchestrator.applyDirective({ runId: run.id, tenant, directive: 'advance' });
      expect(advanced.run.currentStep).toBe(definition.steps[1]);
      expect(body.transitions).toContainEqual({ from: run.currentStep, directive: 'advance', to: advanced.run.currentStep });
      definitions.push(body);
    }
    expect(expectedPath(definitions[0]!)).not.toEqual(expectedPath(definitions[1]!));
  } finally {
    database.close();
  }
});
