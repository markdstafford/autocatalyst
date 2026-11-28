import { describe, expect, it, vi } from 'vitest';

import { ReviewedLiveConversations } from './reviewed-live-conversations.js';

const yes = async () => true;
const scope = (key = 'build/implementer') => ({
  key, run: 'run', generation: 'workspace', compatibility: 'profile', verifyLaunch: yes, verifyWorkspace: yes
});

describe('reviewed live conversations', () => {
  it('leases one turn at a time and discards an unaccepted turn', () => {
    const pool = new ReviewedLiveConversations();
    const resource = { close: vi.fn() };
    const first = pool.open(scope());
    expect(pool.open(scope())).toEqual({ reason: 'active' });
    first.turn!.ready(resource);
    first.finish!(true);

    const second = pool.open(scope());
    expect(second.turn?.resource).toBe(resource);
    expect(second.id).toBe(first.id);
    second.finish!(false);
    expect(resource.close).toHaveBeenCalledOnce();
    expect(pool.open(scope()).turn?.resource).toBeUndefined();
    pool.close();
  });

  it('promotes an author lease only on acceptance and does not reuse across paths, roles or routes', () => {
    const pool = new ReviewedLiveConversations();
    const path = 'context-human/specs/feature-spec.md';
    const candidate = { close: vi.fn() };
    const rejected = pool.open(scope('spec/implementer'));
    rejected.turn!.ready(candidate);
    rejected.finish!(false);
    expect(candidate.close).toHaveBeenCalledOnce();

    const accepted = pool.open(scope('spec/implementer'));
    accepted.turn!.ready(candidate);
    accepted.finish!(true, path);
    const reviewer = pool.open({ ...scope('spec/reviewer'), specPath: path });
    expect(reviewer.turn?.resource).toBeUndefined();
    const resumed = pool.open({ ...scope('spec/implementer'), specPath: path });
    expect(resumed.turn?.resource).toBe(candidate);
    resumed.turn!.ready(candidate);
    resumed.finish!(true, path);
    const changed = pool.open({ ...scope('spec/implementer'), specPath: path + '-different' });
    expect(changed.reason).toBe('scope_changed');
    expect(changed.turn?.resource).toBeUndefined();
    pool.close();
  });

  it('adopts each build role after an overnight pause, then requires the exact PR', async () => {
    vi.useFakeTimers();
    const pool = new ReviewedLiveConversations();
    try {
      const roles = [scope(), scope('build/reviewer')];
      const resources = roles.map(role => {
        const resource = { close: vi.fn() };
        const first = pool.open(role);
        first.turn!.ready(resource);
        first.finish!(true);
        return resource;
      });
      await vi.advanceTimersByTimeAsync(14 * 60 * 60 * 1000);
      for (const [index, role] of roles.entries()) {
        for (const reason of ['repair_adopted', 'compatible']) {
          const repair = pool.open({ ...role, prIdentity: 'verified-pr' });
          expect(repair.reason).toBe(reason);
          expect(repair.turn?.resource).toBe(resources[index]);
          repair.turn!.ready(resources[index]!);
          repair.finish!(true);
        }
        const changed = pool.open({ ...role, prIdentity: 'different-pr' });
        expect(changed.reason).toBe('pr_changed');
        expect(changed.turn?.resource).toBeUndefined();
        expect(resources[index]!.close).toHaveBeenCalledOnce();
      }
    } finally {
      pool.close();
      vi.useRealTimers();
    }
  });

  it('evicts idle entries under pressure, not active leases', () => {
    const pool = new ReviewedLiveConversations(1);
    const idle = { close: vi.fn() };
    const first = pool.open(scope());
    first.turn!.ready(idle);
    expect(pool.open(scope('another'))).toEqual({ reason: 'capacity' });
    first.finish!(true);
    const next = pool.open(scope('another'));
    expect(idle.close).toHaveBeenCalledOnce();
    next.finish!(false);
    expect(pool.open(scope()).reason).toBe('evicted');
    pool.close();
  });

  it.each(['run_terminal', 'workspace_changed'] as const)('fences a late completion after %s', async reason => {
    const pool = new ReviewedLiveConversations();
    const active = pool.open(scope());
    pool.retireRun('run', reason);
    expect(await active.turn?.verifyLaunch()).toBe(false);
    expect(() => active.turn?.submitting?.()).toThrow('before the prompt was accepted');
    const late = { close: vi.fn() };
    active.turn!.ready(late);
    active.finish!(true);
    expect(late.close).toHaveBeenCalledOnce();
    const next = pool.open({ ...scope(), generation: 'new' });
    expect(next.reason).toBe(reason);
    expect(next.turn?.resource).toBeUndefined();
    pool.close();
    expect(pool.open(scope())).toEqual({ reason: 'shutdown' });
    const restarted = new ReviewedLiveConversations();
    expect(restarted.open(scope()).reason).toBe('no_prior');
    restarted.close();
  });

  it('retires an idle workspace that disappears, and reports expiry separately', async () => {
    vi.useFakeTimers();
    const pool = new ReviewedLiveConversations();
    try {
      for (const lost of [true, false]) {
        const resource = { close: vi.fn() };
        const first = pool.open({ ...scope(), verifyWorkspace: async () => !lost });
        first.turn!.ready(resource);
        first.finish!(true);
        await vi.advanceTimersByTimeAsync((lost ? 1 : 48) * 60 * 60 * 1000);
        expect(resource.close).toHaveBeenCalledOnce();
        const fresh = pool.open(scope());
        expect(fresh.reason).toBe(lost ? 'workspace_changed' : 'expired');
        fresh.finish!(false);
      }
    } finally {
      pool.close();
      vi.useRealTimers();
    }
  });
});
