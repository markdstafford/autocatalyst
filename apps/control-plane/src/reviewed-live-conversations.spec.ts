import { describe, expect, it, vi } from 'vitest';

import { ReviewedLiveConversations } from './reviewed-live-conversations.js';

const verify = async () => true;

describe('reviewed live conversations', () => {
  it('leases one turn at a time and discards an unaccepted turn', () => {
    const pool = new ReviewedLiveConversations();
    const resource = { close: vi.fn() };
    const first = pool.open('run/step/role', 'profile', verify)!;
    expect(pool.open('run/step/role', 'profile', verify)).toBeUndefined();
    first.turn.ready(resource);
    first.finish(true);

    const second = pool.open('run/step/role', 'profile', verify)!;
    expect(second.turn.resource).toBe(resource);
    second.finish(false);
    expect(resource.close).toHaveBeenCalledOnce();
    expect(pool.open('run/step/role', 'profile', verify)?.turn.resource).toBeUndefined();
    pool.close();
  });

  it('starts fresh on a compatibility change and closes idle resources on shutdown', () => {
    const pool = new ReviewedLiveConversations();
    const stale = { close: vi.fn() };
    const first = pool.open('run/step/role', 'old-route', verify)!;
    first.turn.ready(stale);
    first.finish(true);

    const replacement = { close: vi.fn() };
    const second = pool.open('run/step/role', 'new-route', verify)!;
    expect(stale.close).toHaveBeenCalledOnce();
    expect(second.turn.resource).toBeUndefined();
    second.turn.ready(replacement);
    second.finish(true);
    pool.close();
    expect(replacement.close).toHaveBeenCalledOnce();
    expect(pool.open('run/step/role', 'new-route', verify)).toBeUndefined();
  });
});
