import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { DefaultOrchestrator, InMemoryRunEventBus, RunDispatchQueue, applyRunDirective, createCodeHostRegistry,
  createPrActivityReader, startRunLifecycle } from '@autocatalyst/core';
import { DrizzleConversationIngressRepository, DrizzleRepairRepository, createDrizzleDomainRepositories,
  createSqliteDatabase, migrateSqliteDatabase } from '@autocatalyst/persistence';
import { createPublicationGit } from './publication-git.js';
import { createRunWorkspaceGitPort } from './run-workspace-git-port.js';

const exec = promisify(execFile);
async function fixture(test: (ctx: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'publication-git-'));
  try { await test(await setup(root)); } finally { await rm(root, { recursive: true, force: true }); }
}
async function git(cwd: string, ...args: string[]) {
  return (await exec('git', args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' } })).stdout.trim();
}
async function setup(root: string) {
  const remote = join(root, 'remote.git');
  const target = join(root, 'target');
  const workspaceRoot = join(root, 'workspaces');
  const work = join(workspaceRoot, 'run');
  await mkdir(workspaceRoot);
  await git(root, 'init', '--bare', '-b', 'main', remote);
  await git(root, 'clone', remote, target);
  await writeFile(join(target, 'shared.txt'), 'base');
  await git(target, 'add', '.');
  await git(target, 'commit', '-m', 'base');
  await git(target, 'push', 'origin', 'main');
  await git(root, 'clone', remote, work);
  const branch = 'feature/run';
  await git(work, 'switch', '-c', branch);
  await git(work, 'config', 'user.name', 'Host');
  await git(work, 'config', 'user.email', 'host@example.com');
  const input = { workspaceRepoRoot: work, branch, remote, repository: 'test/repo', base: 'main', token: 'test' };
  const commit = async (cwd: string, path: string, body: string) => {
    await writeFile(join(cwd, path), body);
    await git(cwd, 'add', '--', path);
    await git(cwd, 'commit', '-m', path);
    return git(cwd, 'rev-parse', 'HEAD');
  };
  return { gitPort: createPublicationGit(workspaceRoot), input, remote, target, work, commit };
}

describe('publication Git', () => {
  it('pins and integrates the current target and refuses to overwrite a divergent source', async () => fixture(async f => {
    const initial = await f.gitPort.integrate(f.input);
    expect(initial).toMatchObject({ kind: 'integrated', sourceSha: await git(f.work, 'rev-parse', 'HEAD'), headSha: await git(f.work, 'rev-parse', 'HEAD') });
    const source = await f.commit(f.work, 'feature.txt', 'run change');
    const target = await f.commit(f.target, 'upstream.txt', 'prior PR');
    await git(f.target, 'push', 'origin', 'main');
    const integrated = await f.gitPort.integrate(f.input);
    expect(integrated).toMatchObject({ kind: 'integrated', sourceSha: source, targetSha: target });
    if (integrated.kind !== 'integrated') throw new Error('Expected integrated commit');
    expect(await git(f.work, 'show', 'HEAD:upstream.txt')).toBe('prior PR');
    expect(await f.gitPort.sameTree(f.input, integrated.headSha, source)).toBe(false);
    expect(await f.gitPort.readTarget(f.input)).toBe(target);
    await git(f.target, 'push', 'origin', 'HEAD:refs/heads/feature/run');
    const human = await f.commit(f.target, 'human.txt', 'external work');
    await git(f.target, 'push', 'origin', 'HEAD:refs/heads/feature/run');
    expect(await f.gitPort.pushCandidate(f.input, integrated.headSha, target)).toBe('unverified');
    expect(await git(f.target, 'ls-remote', f.remote, 'refs/heads/feature/run')).toContain(human);
  }));

  it('preserves the source and restores a clean worktree after a conflict', async () => fixture(async f => {
    const sourceSha = await f.commit(f.work, 'shared.txt', 'local change');
    const targetSha = await f.commit(f.target, 'shared.txt', 'previously merged PR');
    await git(f.target, 'push', 'origin', 'main');
    expect(await f.gitPort.integrate(f.input)).toEqual({
      kind: 'conflict', sourceSha, targetSha, paths: ['shared.txt'], cleanup: 'restored'
    });
    expect(await f.gitPort.readCandidate(f.input)).toBe(sourceSha);
    expect(await git(f.target, 'ls-remote', f.remote, 'refs/heads/feature/run')).toBe('');
  }));

  it('will not touch a dirty or busy worktree and reports unverifiable refs separately', async () => fixture(async f => {
    await writeFile(join(f.work, 'untracked'), 'keep');
    expect(await f.gitPort.integrate(f.input)).toEqual({ kind: 'workspace_unavailable' });
    await rm(join(f.work, 'untracked'));
    const head = await git(f.work, 'rev-parse', 'HEAD');
    await writeFile(join(f.work, '.git', 'CHERRY_PICK_HEAD'), head);
    expect(await f.gitPort.integrate(f.input)).toEqual({ kind: 'workspace_unavailable' });
    await rm(join(f.work, '.git', 'CHERRY_PICK_HEAD'));
    expect(await f.gitPort.integrate({ ...f.input, base: 'missing' })).toEqual({ kind: 'target_unverified', sourceSha: head });
  }));

  it('will not overwrite an ignored local file while integrating the target', async () => fixture(async f => {
    const source = await f.commit(f.work, '.gitignore', 'local.txt\n');
    await writeFile(join(f.work, 'local.txt'), 'keep');
    await f.commit(f.target, 'local.txt', 'target content');
    await git(f.target, 'push', 'origin', 'main');
    expect(await f.gitPort.integrate(f.input)).toEqual({ kind: 'workspace_unavailable' });
    expect(await f.gitPort.readCandidate(f.input)).toBe(source);
    expect(await readFile(join(f.work, 'local.txt'), 'utf8')).toBe('keep');
  }));
});

describe('guarded publication and repair through the run orchestrator', () => {
  it.each(['target-only repair', 'repair guidance after restart', 'conflict after source push',
    'repair with the same tree', 'repair blocked by review'] as const)('%s', async scenario => fixture(async f => {
    const needsGuidance = scenario === 'repair guidance after restart';
    const conflictAfterPush = scenario === 'conflict after source push';
    const database = createSqliteDatabase({ path: ':memory:' });
    try {
      await migrateSqliteDatabase(database);
      const repos = createDrizzleDomainRepositories(database);
      const repairs = new DrizzleRepairRepository(database);
      const owner = { kind: 'human' as const, tenantId: 'test-tenant', id: 'test-human' };
      const project = await repos.projects.create({
        owner, tenant: owner.tenantId, displayName: 'Publication fixture', repoUrl: `file://${f.remote}`,
        hostRepository: { provider: 'github', owner: 'test', name: 'repo' }, workspaceRootOverride: null,
        issueTrackerSetting: null, codeHostSetting: { provider: 'github', credentialRef: { id: 'key', purpose: 'code_host' } },
        credentialRefs: []
      });
      const conversation = await repos.conversations.create({
        projectId: project.id, owner, tenant: owner.tenantId, identity: 'test', activeTopicId: null
      });
      const topic = await repos.topics.create({ conversationId: conversation.id, owner, tenant: owner.tenantId, title: 'Test repair', kind: 'main' });
      let tick = Date.now();
      const clock = () => new Date(tick++).toISOString();
      let state = await startRunLifecycle({ runs: repos.runs, run: { topicId: topic.id, owner, tenant: owner.tenantId, workKind: 'chore' }, clock });
      const runId = state.run.id;
      while (state.run.currentStep !== 'pr.finalize') {
        state = await applyRunDirective({
          runs: repos.runs, runId, directive: 'advance', clock,
          ...(state.run.currentStep === 'implementation.build' ? { checkpointResult: {
            kind: 'cumulative_implementation_summary', cumulativeSummary: 'Run change', changedFiles: ['feature.txt'],
            validationSummary: [], followUps: [], nonGoals: [], sourceRoundCount: 1, completedAt: clock()
          } } : {})
        });
      }
      const branch = f.input.branch;
      await repos.runWorkspaceMetadata.upsert({ runId, workspaceHandle: branch, workspaceRepoRoot: f.work, createdAt: clock() });
      const source = await f.commit(f.work, 'feature.txt', 'feature');
      const prior = await f.commit(f.target, 'prior.txt', 'first PR');
      await git(f.target, 'push', 'origin', 'main');
      let created = 0;
      let merged = false;
      const head = async () => (await git(f.target, 'ls-remote', f.remote, `refs/heads/${branch}`)).split('\t')[0]!;
      const facts = async () => ({
        number: 42, provider: 'github', state: merged ? 'merged' as const : 'open' as const, branch,
        url: 'https://github.com/test/repo/pull/42', headRepository: 'test/repo', baseBranch: 'main', headSha: await head()
      });
      const codeHosts = createCodeHostRegistry([{ provider: 'github', create: () => ({
        create: async input => {
          expect(input.branchAlreadyPushed).toBe(true);
          created++;
          return facts();
        },
        read: facts,
        findByBranch: async () => created > 0 ? facts() : null,
        observeCi: async () => ({
          facts: await facts(), failures: [{ kind: 'check_run' as const, id: 'test', name: 'Tests', conclusion: 'failure' as const }]
        }),
        merge: async () => { throw new Error('Automated merge not allowed'); },
        update: async () => { throw new Error('Cannot edit the PR'); }
      }) }]);
      let builds = 0;
      const reviewed: string[] = [];
      const createOrchestrator = () => new DefaultOrchestrator({
        runs: repos.runs, runSteps: repos.runSteps, runWorkspaceMetadata: repos.runWorkspaceMetadata,
        conversationIngress: new DrizzleConversationIngressRepository(database),
        events: new InMemoryRunEventBus(), dispatchQueue: new RunDispatchQueue({ maxConcurrent: 1 }), clock,
        autoDispatch: { enabled: false },
        resolveWorkspaceContext: async () => ({ workspaceRepoRoot: f.work, workspaceHandle: branch }),
        unitOfWork: { run: async input => {
          expect(input.run.currentStep).toBe('pr.finalize');
          expect(input).toHaveProperty('toolPolicyMode', 'read_only');
          reviewed.push(await git(f.work, 'rev-parse', 'HEAD'));
          if (reviewed.length === 2 && scenario === 'repair blocked by review') return { directive: 'advance', result: {
            directive: 'revise', findings: [{ severity: 'blocker', summary: 'The candidate breaks test isolation.' }]
          } };
          return { directive: 'advance', result: { directive: 'advance', findings: reviewed.length === 2
            ? [{ severity: 'warning', summary: 'Follow up on test coverage.', target: 'implementation' }] : [] } };
        } },
        convergenceEngine: { run: async input => {
          builds++;
          expect(input.ciRepair?.failedHead).toBe(await head());
          const ask = needsGuidance && builds === 1;
          if (needsGuidance && builds === 2) {
            expect(input.humanGuidance).toBe('Use the correction on main');
            expect(input.priorCheckpoint?.outcome).toBe('needs_input');
          }
          if (ask) return {
            workResult: { directive: 'needs_input', question: 'Should repair use the correction on main?' },
            checkpointResult: {
              kind: 'convergence_review', step: 'implementation.build', maxRounds: 1, routing: { distinct: true },
              rounds: [], outcome: 'needs_input', openFeedbackIds: [], lastPositions: {}
            }
          };
          return { workResult: { directive: 'advance' }, checkpointResult: {
            kind: 'convergence_review', step: 'implementation.build', maxRounds: 1, routing: { distinct: true },
            rounds: [], outcome: 'converged', openFeedbackIds: [], lastPositions: {}
          } };
        } },
        pullRequestOpenDependencies: {
          projects: repos.projects, conversations: repos.conversations, topics: repos.topics, pullRequests: repos.pullRequests,
          codeHosts, resolveCredential: async () => ({ token: 'test' }), publicationGit: conflictAfterPush ? {
            ...f.gitPort,
            async pushCandidate(...args) {
              const pushed = await f.gitPort.pushCandidate(...args);
              expect(pushed).toBe('pushed');
              await f.commit(f.target, 'feature.txt', 'conflicting target change after the source push');
              await git(f.target, 'push', 'origin', 'main');
              return pushed;
            }
          } : f.gitPort,
          runWorkspaceGit: createRunWorkspaceGitPort({ workspacesRoot: join(f.work, '..') }), repair: { repository: repairs, limit: 1 }
        }
      });
      const scope = { runId, tenant: owner.tenantId };
      let orchestrator = createOrchestrator();
      expect((await orchestrator.dispatch(scope)).run.currentStep).toBe('pr.open');
      expect(reviewed[0]).not.toBe(source);
      expect(await git(f.work, 'merge-base', reviewed[0]!, prior)).toBe(prior);
      const reader = createPrActivityReader({ repairs, pullRequests: repos.pullRequests, coverage: async () => 'ticker_disabled' });
      if (conflictAfterPush) {
        expect((await orchestrator.dispatch(scope)).run.currentStep).toBe('pr.finalize');
        const failed = await orchestrator.dispatch(scope);
        expect(failed.run.currentStep).toBe('failed');
        expect(await head()).toBe(reviewed[0]);
        expect(await f.gitPort.readCandidate(f.input)).toBe(reviewed[0]);
        expect(created).toBe(0);
        const history = await reader(failed.run, await repos.runSteps.listByRun(runId));
        const finalizations = history.filter(row => row.step === 'pr.finalize');
        expect(finalizations).toHaveLength(2);
        expect(finalizations[1]?.systemActivity).toEqual([expect.objectContaining({
          code: 'pr_integration_conflict', sourcePushed: true, sourceSha: reviewed[0], refreshCount: 1,
          paths: ['feature.txt'], cleanup: 'restored'
        })]);
        return;
      }
      expect((await orchestrator.dispatch(scope)).run.currentStep).toBe('pr.human_review');
      const failedHead = await head();
      expect(failedHead).toBe(reviewed[0]);
      expect((await reader((await repos.runs.findById(runId))!, await repos.runSteps.listByRun(runId))).at(-1)).toMatchObject({ prCiCoverage: 'ticker_disabled' });
      await orchestrator.detectMerges(owner.tenantId); // Non-authorized ingress only reconciles terminal state.
      expect(await repairs.listByRun(runId, owner.tenantId)).toHaveLength(0);
      if (scenario === 'repair with the same tree') await git(f.target, 'commit', '--allow-empty', '-m', 'no tree change');
      else await f.commit(f.target, 'fix.txt', 'required fix landed on main');
      await git(f.target, 'push', 'origin', 'main');
      await orchestrator.detectMerges(owner.tenantId, true);
      if (needsGuidance) {
        await vi.waitFor(async () => expect((await repairs.listByRun(runId, owner.tenantId))[0]?.state).toBe('awaiting_human'));
        orchestrator = createOrchestrator();
        await orchestrator.restoreRepairs();
        expect(builds).toBe(1);
        const [paused] = await repairs.listByRun(runId, owner.tenantId);
        expect(paused).toMatchObject({ ordinal: 1, candidateSha: failedHead, ownerEpoch: null });
        const pause = (await reader((await repos.runs.findById(runId))!, await repos.runSteps.listByRun(runId))).at(-1);
        expect(pause).toMatchObject({
          id: paused?.currentStepId, checkpointResult: { pause: { question: 'Should repair use the correction on main?' } },
          systemActivity: [{ code: 'repair_needs_guidance', ordinal: 1 }]
        });
        const reply = { ...scope, principal: owner, request: {
          kind: 'guidance' as const, pauseStepId: pause!.id, body: 'Use the correction on main'
        } };
        await orchestrator.replyToRun(reply);
        await expect(orchestrator.replyToRun(reply)).rejects.toThrow();
      }
      const stopCode = scenario === 'repair with the same tree' ? 'repair_no_change' :
        scenario === 'repair blocked by review' ? 'repair_final_review_blocked' : undefined;
      if (stopCode !== undefined) {
        await vi.waitFor(async () => expect((await repairs.listByRun(runId, owner.tenantId))[0]).toMatchObject({ state: 'stopped', stopCode }), { timeout: 5000 });
        expect(await head()).toBe(failedHead);
        expect(await f.gitPort.readCandidate(f.input)).not.toBe(failedHead);
        expect(created).toBe(1);
        const history = await reader((await repos.runs.findById(runId))!, await repos.runSteps.listByRun(runId));
        expect(history.slice(-4).map(row => row.step)).toEqual(['pr.human_review', 'implementation.build', 'pr.finalize', 'pr.human_review']);
        expect(history.at(-2)?.systemActivity).toEqual([expect.objectContaining({
          code: stopCode, ...(scenario === 'repair blocked by review'
            ? { findings: [{ severity: 'blocker', summary: 'The candidate breaks test isolation.' }] } : {})
        })]);
        return;
      }
      await vi.waitFor(async () => expect((await repairs.listByRun(runId, owner.tenantId))[0]?.state).toBe('pushed'), { timeout: 5000 });
      expect(await head()).not.toBe(failedHead);
      expect(await head()).toBe(reviewed[1]);
      expect(await git(f.work, 'show', 'HEAD:fix.txt')).toBe('required fix landed on main');
      expect(builds).toBe(needsGuidance ? 2 : 1);
      expect(created).toBe(1);
      await orchestrator.detectMerges(owner.tenantId, true);
      const decisions = await repairs.listByRun(runId, owner.tenantId);
      expect(decisions.map(row => row.state)).toEqual(['pushed', 'exhausted']);
      expect(decisions[1]?.headSha).toBe(await head());
      const finalRun = (await repos.runs.findById(runId))!;
      const history = await reader(finalRun, await repos.runSteps.listByRun(runId));
      expect(history.flatMap(row => row.systemActivity ?? []).find(row => row.code === 'repair_pushed')).toMatchObject({
        findings: [{ severity: 'warning', summary: 'Follow up on test coverage.' }]
      });
      expect(history.flatMap(row => row.systemActivity ?? []).map(row => row.code)).toEqual([
        'pr_target_integrated', 'repair_queued', ...(needsGuidance ? ['repair_needs_guidance'] : []),
        'repair_pushed', 'repair_budget_exhausted'
      ]);
      expect(history.filter(row => row.step === 'pr.human_review')).toHaveLength(2);
      merged = true;
      expect((await orchestrator.detectMerges(owner.tenantId, true)).merged).toBe(1);
      expect((await repos.runs.findById(runId))?.currentStep).toBe('done');
    } finally {
      database.close();
    }
  }), 15_000);
});
