import { describe, expect, it } from 'vitest';
import { applyRunDirective, startRunLifecycle } from '@autocatalyst/core';
import {
  DrizzleRepairRepository, asInternalSqliteDatabase, createDrizzleDomainRepositories, createSqliteDatabase,
  migrateSqliteDatabase, withTempDatabasePath
} from '../index.js';

const owner = { kind: 'human' as const, tenantId: 'tenant_repair', id: 'user_repair' };
const headSha = 'a'.repeat(40);

async function fixture(test: (input: Awaited<ReturnType<typeof seed>>) => Promise<void>) {
  await withTempDatabasePath(async path => {
    const database = createSqliteDatabase({ path });
    const successor = createSqliteDatabase({ path });
    try {
      await migrateSqliteDatabase(database);
      await test(await seed(database, successor));
    } finally {
      successor.close();
      database.close();
    }
  });
}

async function seed(database: ReturnType<typeof createSqliteDatabase>, successor: ReturnType<typeof createSqliteDatabase>) {
  const repos = createDrizzleDomainRepositories(database);
  const sql = asInternalSqliteDatabase(database).client;
  const project = await repos.projects.create({
    owner, tenant: owner.tenantId, displayName: 'P', repoUrl: 'https://github.com/test/repo',
    hostRepository: { provider: 'github', owner: 'test', name: 'repo' }, workspaceRootOverride: null,
    issueTrackerSetting: null, codeHostSetting: { provider: 'github', credentialRef: { id: 'cred', purpose: 'code_host' } },
    credentialRefs: []
  });
  const conversation = await repos.conversations.create({
    projectId: project.id, owner, tenant: owner.tenantId, identity: 'test', activeTopicId: null
  });
  const topic = await repos.topics.create({ conversationId: conversation.id, owner, tenant: owner.tenantId, title: 'Test repair', kind: 'main' });
  let tick = Date.now();
  const clock = () => new Date(tick++).toISOString();
  let state = await startRunLifecycle({ runs: repos.runs, run: { topicId: topic.id, owner, tenant: owner.tenantId, workKind: 'chore' }, clock });
  while (state.run.currentStep !== 'pr.human_review') {
    state = await applyRunDirective({ runs: repos.runs, runId: state.run.id, directive: 'advance', clock });
  }
  const runId = state.run.id;
  const branch = 'chore/repair';
  await repos.runWorkspaceMetadata.upsert({ runId, workspaceHandle: branch, workspaceRepoRoot: '/unused', createdAt: clock() });
  const pr = await repos.pullRequests.create({
    runId, owner, tenant: owner.tenantId, state: 'open', number: 7, url: 'https://github.com/test/repo/pull/7', provider: 'github', branch
  });
  const setPublishedHead = (head: string) => sql.prepare('UPDATE pull_requests SET autocatalyst_head_sha = ? WHERE id = ?').run(head, pr.id);
  const admission = {
    run: state.run, pr, gateId: state.runStep.id, headSha, baseRef: 'main', repository: 'test/repo', limit: 1, now: clock(),
    failures: [{ kind: 'check_run' as const, id: 'check', name: 'Tests', conclusion: 'failure' as const }],
    deadlineMs: Date.now() + 10_000
  };
  return {
    repos, admission, setPublishedHead, clock, runId,
    first: new DrizzleRepairRepository(database), second: new DrizzleRepairRepository(successor)
  };
}

describe('durable CI repair ownership in SQLite', () => {
  it('admits one head and claims one occurrence across separate connections; a stale owner cannot publish', async () => fixture(async f => {
    f.setPublishedHead(headSha);
    const results = await Promise.all([f.first.admit(f.admission), f.second.admit(f.admission)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const admitted = results.find(Boolean)!;
    expect(admitted.decision).toMatchObject({ ordinal: 1, state: 'queued', ownerEpoch: null });
    const [one, two] = await Promise.all([
      f.first.move({ from: admitted.decision, state: 'running', ownerEpoch: 'original', now: f.clock() }),
      f.second.move({ from: admitted.decision, state: 'running', ownerEpoch: 'successor', now: f.clock() })
    ]);
    expect([one, two].filter(Boolean)).toHaveLength(1);
    const claim = (one ?? two)!.decision;
    const ended = await f.second.move({ from: claim, state: 'stopped', nextStep: 'pr.human_review',
      stopCode: 'repair_interrupted', now: f.clock(), hold: true });
    expect(ended?.decision).toMatchObject({ outcomeStepId: claim.currentStepId, workspaceHold: true });
    expect(await f.first.move({ from: claim, state: 'running', nextStep: 'pr.finalize', now: f.clock() })).toBeNull();
    expect(await f.second.admit({ ...f.admission, gateId: ended!.transition!.runStep.id, headSha: 'b'.repeat(40) })).toBeNull();
    await f.first.clearDrainedHold(claim);
    expect((await f.second.listByRun(f.runId, owner.tenantId))[0]?.workspaceHold).toBe(false);
    f.setPublishedHead('b'.repeat(40));
    expect(await f.second.admit({ ...f.admission, gateId: ended!.transition!.runStep.id, headSha: 'b'.repeat(40) }))
      .toMatchObject({ decision: { ordinal: null, state: 'exhausted', stopCode: 'repair_budget_exhausted' } });
    expect((await f.repos.runSteps.listByRun(f.runId)).filter(step => step.step === 'pr.human_review')).toHaveLength(2);
  }));

  it('does not spend an ordinal for zero cap or unverified provenance and does not reconsider a decided head', async () => fixture(async f => {
    expect(await f.first.admit({ ...f.admission, limit: 0 })).toMatchObject({
      decision: { state: 'exhausted', ordinal: null, stopCode: 'repair_disabled', currentStepId: null }
    });
    f.setPublishedHead(headSha);
    expect(await f.second.admit(f.admission)).toBeNull();
    expect(await f.second.admit({ ...f.admission, headSha: 'b'.repeat(40) })).toMatchObject({
      decision: { state: 'external', ordinal: null, stopCode: 'repair_unverified_provenance', currentStepId: null }
    });
    expect((await f.repos.runSteps.listByRun(f.runId)).filter(step => step.step === 'pr.human_review')).toHaveLength(1);
  }));

  it('retains a pause across connections and admits only one exact continuation; bare publish intent cannot advance provenance', async () => fixture(async f => {
    f.setPublishedHead(headSha);
    const queued = await f.first.admit(f.admission);
    const running = await f.first.move({ from: queued!.decision, state: 'running', now: f.clock(), ownerEpoch: 'first' });
    const pause = await f.first.move({
      from: running!.decision, state: 'awaiting_human', nextStep: 'implementation.awaiting_input', now: f.clock(), candidateSha: headSha,
      initialCheckpoint: { pause: { kind: 'convergence_escalation', producingStep: 'implementation.build', question: 'Test?' } }
    });
    expect(await f.second.listRecoverable()).toEqual([]);
    const [a, b] = await Promise.all([f.first, f.second].map(repo => repo.move({
      from: pause!.decision, state: 'queued', nextStep: 'implementation.build', now: f.clock(),
      initialCheckpoint: { humanGuidance: 'Retry this check.' }
    })));
    expect([a, b].filter(Boolean)).toHaveLength(1);
    const continued = (a ?? b)!;
    expect(continued.decision).toMatchObject({ ordinal: 1, repairStepId: queued!.decision.repairStepId, candidateSha: headSha });
    const claim = await f.second.move({ from: continued.decision, state: 'running', now: f.clock(), ownerEpoch: 'next' });
    const finalizing = await f.second.move({ from: claim!.decision, state: 'running', now: f.clock(), nextStep: 'pr.finalize' });
    const publishing = await f.second.move({ from: finalizing!.decision, state: 'publishing', now: f.clock(), publishHeadSha: 'b'.repeat(40) });
    expect(await f.first.move({ from: publishing!.decision, state: 'pushed', nextStep: 'pr.human_review', now: f.clock() })).toBeNull();
    const terminal = await f.first.move({
      from: publishing!.decision, state: 'superseded', nextStep: 'done', prTerminal: 'merged', now: f.clock(), hold: true
    });
    expect(terminal?.transition?.run.currentStep).toBe('done');
    expect((await f.repos.pullRequests.findByRun(f.runId))?.state).toBe('merged');
    expect((await f.repos.runSteps.listByRun(f.runId)).filter(step => step.step === 'pr.human_review')).toHaveLength(1);
    expect(await f.second.move({ from: pause!.decision, state: 'queued', nextStep: 'implementation.build', now: f.clock() })).toBeNull();
  }));
});
