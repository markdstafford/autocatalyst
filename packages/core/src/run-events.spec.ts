import { describe, expect, it } from 'vitest';

import {
  createRunStateTransitionEvent,
  InMemoryRetainedRunEventStore
} from './run-events.js';
import { runStateTransitionEventSchema } from '@autocatalyst/api-contract';

const owner = { id: 'user_1', kind: 'human' as const, tenantId: 'tenant_1', displayName: 'Ada' };
const timestamp = '2026-06-08T00:00:00.000Z';

const validRun = {
  id: 'run_1',
  topicId: 'topic_1',
  owner,
  tenant: 'tenant_1',
  workKind: 'feature',
  currentStep: 'intake',
  terminal: false,
  createdAt: timestamp,
  updatedAt: timestamp
};

const validRunStep = {
  id: 'step_1',
  runId: 'run_1',
  phase: 'intake',
  step: 'intake',
  role: 'none' as const,
  startedAt: timestamp,
  endedAt: null,
  durationMs: null,
  occurrence: { index: 0, attempt: 1 },
  checkpointResult: null
};

function makeEvent(id: string, directive: 'start' | 'advance' = 'advance', tenant = 'tenant_1', runId = 'run_1') {
  return createRunStateTransitionEvent({
    runId,
    directive,
    ...(directive === 'advance' ? { fromStep: 'intake' } : {}),
    toStep: 'spec.author',
    run: { ...validRun, id: runId, tenant },
    runStep: { ...validRunStep, runId },
    tenant,
    idGenerator: () => id,
    clock: () => timestamp
  });
}

describe('createRunStateTransitionEvent', () => {
  it('creates a start event without fromStep', () => {
    const event = createRunStateTransitionEvent({
      runId: 'run_1', directive: 'start', toStep: 'intake',
      run: validRun, runStep: validRunStep, tenant: 'tenant_1'
    });
    expect(event.type).toBe('run_state_transition');
    expect(event.transition.fromStep).toBeUndefined();
    expect(() => runStateTransitionEventSchema.parse(event)).not.toThrow();
  });

  it('uses injected idGenerator and clock', () => {
    const event = createRunStateTransitionEvent({
      runId: 'run_1', directive: 'start', toStep: 'intake',
      run: validRun, runStep: validRunStep, tenant: 'tenant_1',
      idGenerator: () => 'evt_fixed', clock: () => '2026-01-01T00:00:00.000Z'
    });
    expect(event.id).toBe('evt_fixed');
    expect(event.createdAt).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('InMemoryRetainedRunEventStore', () => {
  it('appends and fans-out events to live subscribers in order', async () => {
    const store = new InMemoryRetainedRunEventStore();
    const sub = store.subscribe({ runId: 'run_1', tenant: 'tenant_1' });
    const iter = sub.events[Symbol.asyncIterator]();
    await store.append({ scope: { runId: 'run_1', tenant: 'tenant_1' }, event: makeEvent('evt_1') });
    await store.append({ scope: { runId: 'run_1', tenant: 'tenant_1' }, event: makeEvent('evt_2') });
    const r1 = await iter.next();
    const r2 = await iter.next();
    expect(r1.value.id).toBe('evt_1');
    expect(r2.value.id).toBe('evt_2');
    sub.close();
  });

  it('isolates scopes by tenant and runId', async () => {
    const store = new InMemoryRetainedRunEventStore();
    const subA = store.subscribe({ runId: 'run_1', tenant: 'tenant_1' });
    const subB = store.subscribe({ runId: 'run_1', tenant: 'tenant_2' });
    const iterA = subA.events[Symbol.asyncIterator]();
    await store.append({ scope: { runId: 'run_1', tenant: 'tenant_1' }, event: makeEvent('evt_1', 'advance', 'tenant_1') });
    const r = await iterA.next();
    expect(r.value.id).toBe('evt_1');
    subB.close();
    const iterB = subB.events[Symbol.asyncIterator]();
    expect((await iterB.next()).done).toBe(true);
    subA.close();
  });

  it('replayAfter with no lastEventId returns empty ok', async () => {
    const store = new InMemoryRetainedRunEventStore();
    await store.append({ scope: { runId: 'run_1', tenant: 'tenant_1' }, event: makeEvent('evt_1') });
    const result = await store.replayAfter({ runId: 'run_1', tenant: 'tenant_1' });
    expect(result).toEqual({ status: 'ok', events: [] });
  });

  it('replayAfter returns events strictly after the cursor', async () => {
    const store = new InMemoryRetainedRunEventStore();
    await store.append({ scope: { runId: 'run_1', tenant: 'tenant_1' }, event: makeEvent('evt_1') });
    await store.append({ scope: { runId: 'run_1', tenant: 'tenant_1' }, event: makeEvent('evt_2') });
    await store.append({ scope: { runId: 'run_1', tenant: 'tenant_1' }, event: makeEvent('evt_3') });
    const result = await store.replayAfter({ runId: 'run_1', tenant: 'tenant_1', lastEventId: 'evt_1' });
    if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);
    expect(result.events.map((e) => e.id)).toEqual(['evt_2', 'evt_3']);
  });

  it('replayAfter returns unknown_event_id for an unknown cursor', async () => {
    const store = new InMemoryRetainedRunEventStore();
    await store.append({ scope: { runId: 'run_1', tenant: 'tenant_1' }, event: makeEvent('evt_1') });
    const result = await store.replayAfter({ runId: 'run_1', tenant: 'tenant_1', lastEventId: 'evt_unknown' });
    expect(result).toEqual({ status: 'unknown_event_id', lastEventId: 'evt_unknown' });
  });

  it('evicts oldest events when retention overflows and reports expired_event_id', async () => {
    const store = new InMemoryRetainedRunEventStore({ maxEventsPerScope: 2, maxExpiredIdsPerScope: 4 });
    await store.append({ scope: { runId: 'run_1', tenant: 'tenant_1' }, event: makeEvent('evt_1') });
    await store.append({ scope: { runId: 'run_1', tenant: 'tenant_1' }, event: makeEvent('evt_2') });
    await store.append({ scope: { runId: 'run_1', tenant: 'tenant_1' }, event: makeEvent('evt_3') });
    // evt_1 was evicted
    const expired = await store.replayAfter({ runId: 'run_1', tenant: 'tenant_1', lastEventId: 'evt_1' });
    expect(expired).toEqual({ status: 'expired_event_id', lastEventId: 'evt_1' });
    const ok = await store.replayAfter({ runId: 'run_1', tenant: 'tenant_1', lastEventId: 'evt_2' });
    expect(ok.status).toBe('ok');
  });

  it('rejects events whose runId does not match the scope', async () => {
    const store = new InMemoryRetainedRunEventStore();
    await expect(store.append({
      scope: { runId: 'run_1', tenant: 'tenant_1' },
      event: makeEvent('evt_1', 'advance', 'tenant_1', 'run_other')
    })).rejects.toThrow(/runId/);
  });

  it('closes only the overflowing subscriber and leaves others healthy', async () => {
    const store = new InMemoryRetainedRunEventStore({ subscriberBufferSize: 2 });
    const sub1 = store.subscribe({ runId: 'run_1', tenant: 'tenant_1' });
    const sub2 = store.subscribe({ runId: 'run_1', tenant: 'tenant_1' });
    const iter2 = sub2.events[Symbol.asyncIterator]();

    await store.append({ scope: { runId: 'run_1', tenant: 'tenant_1' }, event: makeEvent('evt_1') });
    await store.append({ scope: { runId: 'run_1', tenant: 'tenant_1' }, event: makeEvent('evt_2') });
    // drain sub2 so its buffer is empty (sub1 still has 2 buffered)
    await iter2.next();
    await iter2.next();

    await store.append({ scope: { runId: 'run_1', tenant: 'tenant_1' }, event: makeEvent('evt_3') });
    // sub1 overflows on evt_3 — it should be closed; sub2 should receive evt_3
    const iter1 = sub1.events[Symbol.asyncIterator]();
    // drain its 2 buffered then expect done
    await iter1.next();
    await iter1.next();
    const r = await iter1.next();
    expect(r.done).toBe(true);

    const r3 = await iter2.next();
    expect(r3.value.id).toBe('evt_3');
    sub2.close();
  });
});
