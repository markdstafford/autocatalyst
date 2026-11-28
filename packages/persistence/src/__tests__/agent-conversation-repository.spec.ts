import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { applyRunDirective, startRunLifecycle } from '@autocatalyst/core';
import {
  DrizzleAgentConversationRepository, asInternalSqliteDatabase, createDrizzleDomainRepositories,
  createSqliteDatabase, migrateSqliteDatabase, withTempDatabasePath,
  type ConversationBinding, type ReviewedDispatchAttempt
} from '../index.js';

const owner = { kind: 'human' as const, tenantId: 'tenant_slot', id: 'user_slot' };

async function seed(path: string) {
  const db = createSqliteDatabase({ path });
  await migrateSqliteDatabase(db);
  const repos = createDrizzleDomainRepositories(db);
  const project = await repos.projects.create({
    owner, tenant: owner.tenantId, displayName: 'P', repoUrl: 'https://github.com/test/repo',
    hostRepository: { provider: 'github', owner: 'test', name: 'repo' }, workspaceRootOverride: null,
    issueTrackerSetting: null, codeHostSetting: null, credentialRefs: []
  });
  const conversation = await repos.conversations.create({
    projectId: project.id, owner, tenant: owner.tenantId, identity: 'test', activeTopicId: null
  });
  const topic = await repos.topics.create({ conversationId: conversation.id, owner, tenant: owner.tenantId, title: 'Slots', kind: 'main' });
  const clock = () => new Date().toISOString();
  let run = await startRunLifecycle({ runs: repos.runs, run: { topicId: topic.id, owner, tenant: owner.tenantId, workKind: 'feature' }, clock });
  const move = async (directive: 'advance' | 'revise' = 'advance') => {
    run = await applyRunDirective({ runs: repos.runs, runId: run.run.id, directive, clock });
  };
  await move();
  const runId = run.run.id;
  await repos.runWorkspaceMetadata.upsert({ runId, workspaceHandle: 'work', workspaceRepoRoot: '/repo', createdAt: clock() });
  const slots = new DrizzleAgentConversationRepository(db);
  const enroll = (proof: string | null) => slots.enroll({ tenant: owner.tenantId, runId, root: '/repo', branch: 'work', proof });
  const binding: ConversationBinding = {
    generation: enroll('original-proof')!, compatibilityDigest: 'compatible', scopeDigest: 'unchanged-contract', prIdentity: null
  };
  const attempt = (role: ReviewedDispatchAttempt['role'] = 'implementer'): ReviewedDispatchAttempt => ({
    tenant: owner.tenantId, runId: run.run.id, id: `sess_${randomUUID()}`, role,
    occurrenceId: run.runStep.id, round: 1, step: run.run.currentStep as ReviewedDispatchAttempt['step']
  });
  const record = (a: ReviewedDispatchAttempt) => repos.sessions.create({
    runId: a.runId, phase: a.step.split('.')[0]!, step: a.step, role: a.role, round: a.round,
    model: { provider: 'openai', model: 'fixture' }, inferenceSettings: {}, startedAt: clock(), endedAt: clock(),
    durationMs: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, usageAvailable: false,
    assistantTurnCount: 1, toolCallCount: 0, outcome: 'succeeded',
    cost: { model: { provider: 'openai', model: 'fixture' }, usd: null, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
  }, a.id);
  return { slots, db, enroll, binding, attempt, move, record, repos, runId };
}

describe('agent conversation slots', () => {
  it('persists each exact key, orders across occurrences, and adopts the first verified PR binding', async () => {
    await withTempDatabasePath(async path => {
      const f = await seed(path);
      const successor = createSqliteDatabase({ path });
      const reopened = new DrizzleAgentConversationRepository(successor);
      try {
        const save = async (a: ReviewedDispatchAttempt, handle: string) => {
          const claim = f.slots.begin(a, f.binding)!;
          expect(claim.resume).toBeUndefined();
          expect(f.slots.finish(a, claim, { handle, storageScope: 'scope' })).toBe(false);
          // The failed publication retires that claim, so start a new attempt.
          const next = { ...a, id: `sess_${randomUUID()}` };
          const fresh = f.slots.begin(next, f.binding)!;
          await f.record(next);
          expect(await f.record(next)).toMatchObject({ id: next.id });
          expect(f.slots.finish(next, fresh, { handle, storageScope: 'scope' })).toBe(true);
        };
        await save(f.attempt(), 'spec_author');
        await save(f.attempt('reviewer'), 'spec_review');
        await f.move(); await f.move(); await f.move(); // spec gate, plan, build
        await save(f.attempt(), 'implementation');
        await save(f.attempt('reviewer'), 'implementation_review');
        await f.move(); // implementation gate
        await f.move('revise'); // new build occurrence, same scope
        for (const [role, handle] of [['implementer', 'implementation'], ['reviewer', 'implementation_review']] as const) {
          const dispatch = f.attempt(role);
          const bound = { ...f.binding, prIdentity: 'test/repo#12' };
          const adopted = reopened.begin(dispatch, bound)!;
          expect(adopted.resume?.handle).toBe(handle);
          expect(adopted.binding.scopeDigest).toBe(f.binding.scopeDigest);
          await f.record(dispatch);
          expect(reopened.finish(dispatch, adopted, { handle, storageScope: 'scope' })).toBe(true);
          const stored = asInternalSqliteDatabase(successor).client.prepare(
            'select pr_identity, scope_digest from agent_conversation_slots where step = ? and role = ?'
          ).get(dispatch.step, role);
          expect(stored).toEqual({ pr_identity: 'test/repo#12', scope_digest: f.binding.scopeDigest });
        }
        expect(asInternalSqliteDatabase(successor).client.prepare('select count(*) as n from agent_conversation_slots').get()).toEqual({ n: 4 });
      } finally { successor.close(); f.db.close(); }
    });
  });

  it('only reports unrecorded launches, not enrollment, preflight, or completed attempts', async () => {
    await withTempDatabasePath(async path => {
      const f = await seed(path);
      try {
        const launch = { startedAt: new Date().toISOString(), model: { provider: 'openai', model: 'fixture' }, inferenceSettings: {} };
        const preflight = f.attempt();
        f.slots.begin(preflight);
        f.slots.markLaunched(preflight, launch);
        f.slots.markFreshAfterPreflight(preflight);
        expect(f.slots.unrecordedLaunches()).toEqual([]);
        const invoked = f.attempt();
        f.slots.begin(invoked);
        f.slots.markLaunched(invoked, launch);
        expect(f.slots.unrecordedLaunches()).toMatchObject([{ id: invoked.id, launch, occurrenceId: invoked.occurrenceId }]);
        await f.record(invoked);
        expect(f.slots.unrecordedLaunches()).toEqual([]);
      } finally { f.db.close(); }
    });
  });

  it('rejects wrong tenants, retires unmatched history, and fences stale completions on replacement', async () => {
    await withTempDatabasePath(async path => {
      const f = await seed(path);
      try {
        const first = f.attempt();
        expect(() => f.slots.begin({ ...first, tenant: 'another' }, f.binding)).toThrow('not_owned');
        const claim = f.slots.begin(first, f.binding)!;
        await f.record(first);
        expect(f.slots.finish(first, claim, { handle: 'thread', storageScope: 'private' })).toBe(true);
        // A later dispatch not eligible to retain must retire the prior handle,
        // even if no Session row could be written for the intervening dispatch.
        expect(f.slots.begin(f.attempt())).toBeUndefined();
        const observed = f.attempt();
        const replacement = f.slots.begin(observed, f.binding)!;
        expect(replacement.resume).toBeUndefined();
        expect(f.enroll('changed-at-same-path')).not.toBe(f.binding.generation);
        await f.record(observed);
        expect(f.slots.finish(observed, replacement, { handle: 'late', storageScope: 'private' })).toBe(false);
        expect(f.enroll(null)).toBeNull();
        expect(f.slots.begin(f.attempt(), f.binding)).toBeUndefined();
      } finally { f.db.close(); }
    });
  });
});
