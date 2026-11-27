import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createLayeredConvergenceEngine, defaultReviewerWorkspacePolicy, DefaultOrchestrator, InMemoryRunEventBus, RunDispatchQueue, type ControlPlaneService } from '@autocatalyst/core';
import type { Principal } from '@autocatalyst/api-contract';
import { DrizzleConversationIngressRepository, createDrizzleDomainRepositories, createSqliteDatabase, migrateSqliteDatabase } from '@autocatalyst/persistence';

import { createControlPlaneServer } from './server.js';

const owner = { id: 'operator', kind: 'human', tenantId: 'tenant_dev' } as const;
const tenant = owner.tenantId;
const authorization = { authorization: 'Bearer token' };
const json = { ...authorization, 'content-type': 'application/json' };
const time = '2026-11-26T12:00:00.000Z';

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((release) => { resolve = release; });
  return { promise, resolve };
}

async function recordScriptedSession(repositories: ReturnType<typeof createDrizzleDomainRepositories>, runId: string, step: string,
  role: 'implementer' | 'reviewer' = 'implementer', round = 1
) {
  const model = { provider: 'scripted', model: 'operator-test' };
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  await repositories.sessions.create({
    runId, step, phase: step.startsWith('spec.') ? 'spec' : 'implementation', role,
    round, startedAt: time, endedAt: time, durationMs: 0, tokens, usageAvailable: false,
    assistantTurnCount: 0, toolCallCount: 0, outcome: 'succeeded', model, inferenceSettings: {},
    cost: { model, tokens }
  });
}

it('enforces operator policy, cancels before session release, archives without losing history, and reruns a reached step', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ac-operator-'));
  const databasePath = join(root, 'control-plane.sqlite');
  const database = createSqliteDatabase({ path: databasePath });
  await migrateSqliteDatabase(database);
  const repos = createDrizzleDomainRepositories(database);
  let service!: ControlPlaneService;
  let principal: Principal = owner;
  let allowed = true;
  const authorize = vi.fn(async () => ({ allowed }));
  const specEntered = barrier();
  const specRelease = barrier();
  const buildEntered = barrier();
  const buildRelease = barrier();
  const app = await createControlPlaneServer({
    databasePath, bearerToken: 'token', masterSecret: 'test-master-secret',
    resolvePrincipal: () => principal,
    autoDispatch: { enabled: false },
    policy: { authorize },
    onControlPlaneReady: (ready) => { service = ready; },
    unitOfWork: {
      async run({ runId, run }) {
        if (run.currentStep === 'spec.author') {
          specEntered.resolve();
          await specRelease.promise;
        } else if (run.currentStep === 'implementation.build') {
          buildEntered.resolve();
          await buildRelease.promise;
        } else {
          throw new Error('Unexpected dispatch.');
        }
        await recordScriptedSession(repos, runId, run.currentStep);
        return { directive: 'advance' };
      }
    }
  });

  try {
    const project = await repos.projects.create({
      owner, tenant, displayName: 'Widgets', repoUrl: 'https://example.test/widgets',
      hostRepository: { provider: 'github', owner: 'acme', name: 'widgets' },
      workspaceRootOverride: null, issueTrackerSetting: null, codeHostSetting: null, credentialRefs: []
    });
    const conversation = await repos.conversations.create({
      projectId: project.id, owner, tenant, identity: 'operator-actions', activeTopicId: null
    });
    const seed = async (title: string, step: 'spec.author' | 'implementation.build') => {
      const topic = await repos.topics.create({ conversationId: conversation.id, owner, tenant, title, kind: 'main' });
      return repos.runs.recordRunLifecycleStart({
        run: {
          topicId: topic.id, owner, tenant, workKind: 'bug', currentStep: step, terminal: false,
          trackedIssue: { number: 42, title: 'Tracker title', state: 'open', body: '', labels: [], url: 'https://example.test/issues/42' }
        },
        runStep: { phase: step === 'spec.author' ? 'spec' : 'implementation', step, role: 'none', startedAt: time, endedAt: null, durationMs: null }
      });
    };
    const initial = await seed('Original title', 'spec.author');
    const base = `/v1/runs/${initial.run.id}`;
    const request = (method: 'POST' | 'PATCH' | 'GET', url: string, body?: unknown) => app.inject({
      method, url, headers: body === undefined ? authorization : json,
      ...(body === undefined ? {} : { payload: JSON.stringify(body) })
    });
    const actions = [
      ['POST', '/cancel', 'run_cancel.create', 'run_cancel', {}],
      ['POST', '/archive', 'run_archive.create', 'run_archive', {}],
      ['POST', '/unarchive', 'run_unarchive.create', 'run_unarchive', {}],
      ['POST', '/set-step', 'run_set_step.create', 'run_set_step', { step: 'spec.author' }],
      ['PATCH', '', 'run_rename.update', 'run_rename', { title: 'Valid' }]
    ] as const;
    for (const [method, suffix, action, kind, body] of actions) {
      allowed = false;
      expect((await request(method, base + suffix, null)).statusCode).toBe(403);
      expect(authorize).toHaveBeenLastCalledWith({
        principal: owner, action, resource: { kind, id: initial.run.id, path: `/v1/runs/:id${suffix}` }
      });
      allowed = true;
      principal = { id: 'model', kind: 'model', tenantId: tenant };
      expect((await request(method, base + suffix, null)).statusCode).toBe(403);
      principal = owner;
      const invalid = await request(method, base + suffix, null);
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toMatchObject({ error: { code: 'validation_error' } });
      principal = { ...owner, tenantId: 'another_tenant' };
      const foreign = await request(method, base + suffix, body);
      expect(foreign.statusCode).toBe(404);
      principal = owner;
      const missing = await request(method, `/v1/runs/${initial.run.id}_missing${suffix}`, body);
      expect(missing.statusCode).toBe(404);
    }

    expect((await request('POST', base + '/archive')).statusCode).toBe(409);
    const tick = service.tick({ principal: owner, tenant, runId: initial.run.id });
    await specEntered.promise;
    const canceled = await request('POST', base + '/cancel');
    expect(canceled.statusCode).toBe(200);
    expect(canceled.json()).toMatchObject({ run: { currentStep: 'canceled', status: 'canceled', title: 'Original title', projectId: project.id } });
    expect((await request('GET', base + '/sessions')).json().sessions).toEqual([]);
    specRelease.resolve();
    await tick;
    expect((await request('GET', base + '/sessions')).json().sessions).toEqual([expect.objectContaining({ step: 'spec.author' })]);
    expect(await repos.artifacts.findByRunAndKind({ runId: initial.run.id, kind: 'bug_triage' })).toBeNull();
    expect((await request('POST', base + '/replies', { kind: 'approve' })).statusCode).toBe(409);
    expect((await request('POST', base + '/recover')).statusCode).toBe(409);

    const archive = await request('POST', base + '/archive', {});
    expect(archive.statusCode).toBe(200);
    expect(archive.json().run.archivedAt).toEqual(expect.any(String));
    expect((await request('POST', base + '/archive')).json()).toEqual(archive.json());
    expect((await request('GET', '/v1/runs')).json().runs).toEqual([]);
    for (const mode of ['include', 'only']) {
      expect((await request('GET', `/v1/runs?archived=${mode}`)).json().runs).toEqual([archive.json().run]);
    }
    expect((await request('GET', base)).json()).toEqual(archive.json().run);
    expect((await request('GET', base + '/steps')).json().steps).toHaveLength(2);
    expect((await request('GET', base + '/sessions')).json().sessions).toHaveLength(1);
    expect((await request('GET', base + '/feedback')).statusCode).toBe(200);
    expect((await request('GET', base + '/spec')).statusCode).toBe(404);
    expect((await request('GET', base + '/pull-request')).statusCode).toBe(404);
    const renamed = await request('PATCH', base, { title: '  Renamed <run>  ' });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ run: { title: 'Renamed <run>', trackedIssue: { title: 'Tracker title' } } });
    const unarchived = await request('POST', base + '/unarchive');
    expect(unarchived.statusCode).toBe(200);
    expect(unarchived.json().run).not.toHaveProperty('archivedAt');
    expect((await request('GET', '/v1/runs')).json().runs).toEqual([unarchived.json().run]);
    // End only the live tail in this test so Fastify injection can read the entire
    // retained SSE response without a listening socket. Replay still uses the real store.
    const subscribe = service.subscribeRunEvents.bind(service);
    vi.spyOn(service, 'subscribeRunEvents').mockImplementation(async (input) => {
      const subscription = await subscribe(input);
      subscription.close();
      return subscription;
    });
    const replay = async (url: string) => {
      const response = await request('GET', url + '/events?replay=retained');
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/event-stream');
      return response.body.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
    };
    const cancelReplay = await replay(base);
    expect(cancelReplay).toEqual([
      expect.objectContaining({ transition: { directive: 'cancel', fromStep: 'spec.author', toStep: 'canceled' } })
    ]);

    // A terminal archived run does not occupy the topic's active slot. Create a
    // second run through the existing-topic orchestrator, not through public intake.
    expect((await request('POST', base + '/archive')).statusCode).toBe(200);
    const fixtureOrchestrator = new DefaultOrchestrator({
      runs: repos.runs, runSteps: repos.runSteps, conversationIngress: new DrizzleConversationIngressRepository(database),
      events: new InMemoryRunEventBus(), dispatchQueue: new RunDispatchQueue({ maxConcurrent: 1 }),
      autoDispatch: { enabled: false }
    });
    const next = await fixtureOrchestrator.createRun({ topicId: initial.run.topicId, owner, tenant, workKind: 'bug' });
    const active = { runId: next.run.id, tenant };
    for (const _step of ['intake', 'spec.author', 'implementation.plan']) {
      await fixtureOrchestrator.applyDirective({ ...active, directive: 'advance' });
    }
    const second = {
      run: (await repos.runs.findById(next.run.id))!,
      runStep: (await repos.runs.findLatestOpenRunStep({ runId: next.run.id, step: 'implementation.build' }))!
    };
    expect((await request('PATCH', `/v1/runs/${next.run.id}`, { title: 'Shared title' })).statusCode).toBe(200);
    expect((await request('GET', base)).json().title).toBe('Shared title');
    const both = (await request('GET', '/v1/runs?archived=include')).json().runs;
    expect(both).toHaveLength(2);
    expect(both).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: next.run.id, title: 'Shared title' }),
      expect.objectContaining({ id: initial.run.id, title: 'Shared title', archivedAt: expect.any(String) })
    ]));
    const repeatBase = `/v1/runs/${second.run.id}`;
    await repos.runs.recordRunStepTransition({
      runId: second.run.id, expectedStep: 'implementation.build', sourceRunStepId: second.runStep.id,
      currentStep: 'implementation.human_review', terminal: false,
      runStep: { phase: 'implementation', step: 'implementation.human_review', role: 'none', startedAt: new Date().toISOString(), endedAt: null, durationMs: null }
    });
    const move = await request('POST', repeatBase + '/set-step', { step: 'implementation.build' });
    expect(move.statusCode).toBe(200);
    expect(move.json().run.currentStep).toBe('implementation.build');
    await buildEntered.promise;
    const forward = await request('POST', repeatBase + '/set-step', { step: 'implementation.human_review' });
    expect(forward.statusCode).toBe(400);
    expect(forward.json().error.details.reason).toMatch(/not strictly earlier/);
    buildRelease.resolve();
    await vi.waitFor(async () => expect((await request('GET', repeatBase)).json().currentStep).toBe('implementation.human_review'));
    const steps = (await request('GET', repeatBase + '/steps')).json().steps;
    expect(steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: second.runStep.id, endedAt: expect.any(String), occurrence: { index: 3, attempt: 1 } }),
      expect.objectContaining({ step: 'implementation.build', endedAt: expect.any(String), occurrence: { index: 5, attempt: 2 } })
    ]));
    expect((await request('GET', repeatBase + '/sessions')).json().sessions).toHaveLength(1);
    expect(await replay(repeatBase)).toEqual([
      expect.objectContaining({ transition: { directive: 'set_step', fromStep: 'implementation.human_review', toStep: 'implementation.build' } }),
      expect.objectContaining({ transition: { directive: 'advance', fromStep: 'implementation.build', toStep: 'implementation.human_review' } })
    ]);
  } finally {
    specRelease.resolve();
    buildRelease.resolve();
    await app.close();
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

it.each([
  { workKind: 'feature', step: 'spec.author', blockRound: 1 },
  { workKind: 'enhancement', step: 'spec.author', blockRound: 2 },
  { workKind: 'chore', step: 'implementation.build', blockRound: 1 }
] as const)('drops late $workKind convergence effects while recording all scripted rounds', async ({ workKind, step, blockRound }) => {
  const root = await mkdtemp(join(tmpdir(), 'ac-cancel-convergence-'));
  const databasePath = join(root, 'control-plane.sqlite');
  const repoRoot = join(root, 'repo');
  await Promise.all([mkdir(repoRoot), mkdir(join(root, 'scratch'))]);
  const database = createSqliteDatabase({ path: databasePath });
  await migrateSqliteDatabase(database);
  const repos = createDrizzleDomainRepositories(database);
  const entered = barrier();
  const release = barrier();
  const roleCalls: string[] = [];
  const warn = vi.fn();
  const error = vi.fn();
  const commitFiles = vi.fn(async () => ({ commitSha: null, changedFileCount: 0, changedFilePaths: [] }));
  const spec = step === 'spec.author';
  const telemetry: Record<string, unknown>[] = [];
  const convergenceEngine = createLayeredConvergenceEngine({
    runSteps: repos.runSteps,
    feedback: repos.feedback,
    git: {
      commitFiles, captureCheckpointRef: vi.fn(), readFileAtRef: vi.fn(),
      listFilesAtRef: vi.fn(), getChangedFiles: vi.fn(), reviewerPolicy: defaultReviewerWorkspacePolicy
    },
    routing: {
      resolveAgentRoute: vi.fn(), resolveDirectRoute: vi.fn(), resolveDistinctAgentRoutes: vi.fn().mockResolvedValue({
        resolutionsByRole: {
          implementer: { profileId: 'impl', profile: { model: { provider: 'script', model: 'impl' } } },
          reviewer: { profileId: 'rev', profile: { model: { provider: 'script', model: 'rev' } } }
        }
      })
    },
    logger: { warn, error },
    dispatcher: {
      async runRole(call) {
        const { runId, role, round } = call;
        roleCalls.push(`${role}-${round}`);
        if (role === 'implementer' && round === blockRound) {
          entered.resolve();
          await release.promise;
        }
        await recordScriptedSession(repos, runId, step, role, round);
        if (role === 'reviewer') {
          return { workResult: { directive: 'advance', result: round === 1 ? {
            status: 'findings',
            findings: [{ title: 'Clarify edge case', body: 'Add an example.', severity: 'blocker', ...(spec ? { scope: 'document' } : {}) }]
          } : { status: 'satisfied' } } };
        }
        if (spec) {
          return { workResult: { directive: 'advance', result: {
            spec: { kind: `${workKind}_spec`, slug: 'operator-test', relativePath: `context-human/specs/${workKind}-operator-test.md`,
              frontmatter: { status: 'draft', created: '2026-11-27', last_updated: '2026-11-27', specced_by: 'autocatalyst' }, body: '# Draft\n\nAn edge case.' },
            dispositions: (call.specReview?.feedback ?? []).map(({ feedbackId }) => ({ feedbackId, disposition: 'fixed', summary: 'Clarified it.' }))
          } } };
        }
        return { workResult: { directive: 'advance' }, dispositions: (call.reviewContext?.requiredDispositions ?? [])
          .map(({ feedbackId }) => ({ feedbackId, disposition: 'fixed', summary: 'Clarified it.' })) };
      }
    }
  });
  let service!: ControlPlaneService;
  const app = await createControlPlaneServer({
    databasePath, bearerToken: 'token', masterSecret: 'test-master-secret',
    resolvePrincipal: () => owner,
    autoDispatch: { enabled: false },
    unitOfWork: { run: vi.fn().mockRejectedValue(new Error('Convergence must use reviewed sessions.')) },
    resolveWorkspaceContext: async () => ({ workspaceRepoRoot: repoRoot, workspaceHandle: 'scripted' }),
    convergenceEngine,
    onControlPlaneReady: (ready) => { service = ready; },
    logger: { stream: { write(line: string) { telemetry.push(JSON.parse(line)); } } }
  });
  try {
    const project = await repos.projects.create({
      owner, tenant, displayName: 'Widgets', repoUrl: 'https://example.test/widgets',
      hostRepository: { provider: 'github', owner: 'acme', name: 'widgets' }, workspaceRootOverride: null,
      issueTrackerSetting: null, codeHostSetting: null, credentialRefs: []
    });
    const conversation = await repos.conversations.create({ projectId: project.id, owner, tenant, identity: 'convergence', activeTopicId: null });
    const topic = await repos.topics.create({ conversationId: conversation.id, owner, tenant, title: 'Convergence', kind: 'main' });
    const started = await repos.runs.recordRunLifecycleStart({
      run: { topicId: topic.id, owner, tenant, workKind, currentStep: step, terminal: false },
      runStep: { phase: spec ? 'spec' : 'implementation', step, role: 'none', startedAt: time, endedAt: null, durationMs: null }
    });
    const runId = started.run.id;
    const base = `/v1/runs/${runId}`;
    const tick = service.tick({ runId, tenant, principal: owner });
    await Promise.race([entered.promise, tick.then(() => { throw new Error('Script did not reach the blocked session.'); })]);
    const before = await repos.feedback.listByRun(runId);
    const checkpoint = (await repos.runSteps.findById(started.runStep.id))?.checkpointResult;
    expect(before).toHaveLength(blockRound === 1 ? 0 : 1);
    expect(checkpoint === null).toBe(blockRound === 1);

    const cancel = await app.inject({ method: 'POST', url: base + '/cancel', headers: authorization });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().run.currentStep).toBe('canceled');
    release.resolve();
    await tick;
    expect(roleCalls).toEqual(['implementer-1', 'reviewer-1', 'implementer-2', 'reviewer-2']);
    const sessions = await app.inject({ method: 'GET', url: base + '/sessions', headers: authorization });
    expect(sessions.json().sessions).toHaveLength(4);
    expect(await repos.feedback.listByRun(runId)).toEqual(before);
    expect((await repos.runSteps.findById(started.runStep.id))?.checkpointResult).toEqual(checkpoint);
    expect(await repos.artifacts.listByRun(runId)).toEqual([]);
    expect(await readdir(repoRoot)).toEqual([]);
    expect(commitFiles).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(telemetry.filter(record => record['msg'] === 'dispatch_result_discarded')).toEqual([
      expect.objectContaining({ runId, step })
    ]);
    expect(await service.replayRunEvents({ principal: owner, tenant, runId, replay: 'retained' })).toMatchObject({
      status: 'ok', events: [expect.objectContaining({ transition: expect.objectContaining({ directive: 'cancel' }) })]
    });
  } finally {
    release.resolve();
    await app.close();
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
