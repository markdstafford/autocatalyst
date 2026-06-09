import { describe, expect, it } from 'vitest';

import { createRunStateTransitionEvent, InMemoryRunEventBus, RunEventSubscriptionOverflowError } from './run-events.js';
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
  occurrence: { index: 0, attempt: 1 }
};

describe('createRunStateTransitionEvent', () => {
  it('creates a start event without fromStep', () => {
    const event = createRunStateTransitionEvent({
      runId: 'run_1',
      directive: 'start',
      toStep: 'intake',
      run: validRun,
      runStep: validRunStep,
      tenant: 'tenant_1'
    });

    expect(event.type).toBe('run_state_transition');
    expect(event.runId).toBe('run_1');
    expect(event.transition.directive).toBe('start');
    expect(event.transition.toStep).toBe('intake');
    expect(event.transition.fromStep).toBeUndefined();
    expect(event.tenant).toBe('tenant_1');
    // Passes schema validation (parse would throw if not valid)
    expect(() => runStateTransitionEventSchema.parse(event)).not.toThrow();
  });

  it('creates an advance event with fromStep', () => {
    const event = createRunStateTransitionEvent({
      runId: 'run_1',
      directive: 'advance',
      fromStep: 'intake',
      toStep: 'spec.author',
      run: validRun,
      runStep: validRunStep,
      tenant: 'tenant_1'
    });

    expect(event.transition.directive).toBe('advance');
    expect(event.transition.fromStep).toBe('intake');
    expect(event.transition.toStep).toBe('spec.author');
  });

  it('uses injected idGenerator and clock', () => {
    const event = createRunStateTransitionEvent({
      runId: 'run_1',
      directive: 'start',
      toStep: 'intake',
      run: validRun,
      runStep: validRunStep,
      tenant: 'tenant_1',
      idGenerator: () => 'evt_fixed_id',
      clock: () => '2026-01-01T00:00:00.000Z'
    });

    expect(event.id).toBe('evt_fixed_id');
    expect(event.createdAt).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('InMemoryRunEventBus', () => {
  it('delivers a published event to a subscriber', async () => {
    const bus = new InMemoryRunEventBus();
    const event = createRunStateTransitionEvent({
      runId: 'run_1',
      directive: 'start',
      toStep: 'intake',
      run: validRun,
      runStep: validRunStep,
      tenant: 'tenant_1',
      idGenerator: () => 'evt_1',
      clock: () => timestamp
    });

    const sub = bus.subscribe({ runId: 'run_1', tenant: 'tenant_1' });
    const iter = sub.events[Symbol.asyncIterator]();
    bus.publish(event);
    const result = await iter.next();
    expect(result.done).toBe(false);
    expect(result.value).toEqual(event);
    sub.close();
  });

  it('filters by runId+tenant — only matching subscriber receives event', async () => {
    const bus = new InMemoryRunEventBus();
    const event = createRunStateTransitionEvent({
      runId: 'run_1',
      directive: 'start',
      toStep: 'intake',
      run: validRun,
      runStep: validRunStep,
      tenant: 'tenant_1',
      idGenerator: () => 'evt_1',
      clock: () => timestamp
    });

    const sub1 = bus.subscribe({ runId: 'run_1', tenant: 'tenant_1' });
    const sub2 = bus.subscribe({ runId: 'run_other', tenant: 'tenant_2' });

    const iter1 = sub1.events[Symbol.asyncIterator]();
    bus.publish(event);

    const result1 = await iter1.next();
    expect(result1.done).toBe(false);
    expect(result1.value).toEqual(event);

    // sub2 should not have received anything; close it and check done
    sub2.close();
    const iter2 = sub2.events[Symbol.asyncIterator]();
    const result2 = await iter2.next();
    expect(result2.done).toBe(true);

    sub1.close();
  });

  it('delivers events in publication order', async () => {
    const bus = new InMemoryRunEventBus();

    const makeEvent = (id: string) => createRunStateTransitionEvent({
      runId: 'run_1',
      directive: 'advance',
      fromStep: 'intake',
      toStep: 'spec.author',
      run: validRun,
      runStep: validRunStep,
      tenant: 'tenant_1',
      idGenerator: () => id,
      clock: () => timestamp
    });

    const sub = bus.subscribe({ runId: 'run_1', tenant: 'tenant_1' });
    const iter = sub.events[Symbol.asyncIterator]();

    const e1 = makeEvent('evt_1');
    const e2 = makeEvent('evt_2');
    const e3 = makeEvent('evt_3');

    bus.publish(e1);
    bus.publish(e2);
    bus.publish(e3);

    const r1 = await iter.next();
    const r2 = await iter.next();
    const r3 = await iter.next();

    expect(r1.value.id).toBe('evt_1');
    expect(r2.value.id).toBe('evt_2');
    expect(r3.value.id).toBe('evt_3');

    sub.close();
  });

  it('stops delivering events after close', async () => {
    const bus = new InMemoryRunEventBus();
    const event = createRunStateTransitionEvent({
      runId: 'run_1',
      directive: 'start',
      toStep: 'intake',
      run: validRun,
      runStep: validRunStep,
      tenant: 'tenant_1',
      idGenerator: () => 'evt_1',
      clock: () => timestamp
    });

    const sub = bus.subscribe({ runId: 'run_1', tenant: 'tenant_1' });
    const iter = sub.events[Symbol.asyncIterator]();
    sub.close();

    // After close, next() should resolve done immediately
    const result = await iter.next();
    expect(result.done).toBe(true);

    // Publishing after close should not cause issues
    bus.publish(event);
  });

  it('removes subscriber on close (no leak)', () => {
    const bus = new InMemoryRunEventBus();
    const sub = bus.subscribe({ runId: 'run_1', tenant: 'tenant_1' });
    sub.close();

    // After close, publishing should not throw (no subscribers to deliver to)
    const event = createRunStateTransitionEvent({
      runId: 'run_1',
      directive: 'start',
      toStep: 'intake',
      run: validRun,
      runStep: validRunStep,
      tenant: 'tenant_1',
      idGenerator: () => 'evt_1',
      clock: () => timestamp
    });
    expect(() => bus.publish(event)).not.toThrow();
  });

  it('throws RunEventSubscriptionOverflowError when buffer overflows', () => {
    const bus = new InMemoryRunEventBus();
    const sub = bus.subscribe({ runId: 'run_1', tenant: 'tenant_1' });

    const makeEvent = (i: number) => createRunStateTransitionEvent({
      runId: 'run_1',
      directive: 'advance',
      fromStep: 'intake',
      toStep: 'spec.author',
      run: validRun,
      runStep: validRunStep,
      tenant: 'tenant_1',
      idGenerator: () => `evt_${i}`,
      clock: () => timestamp
    });

    // Fill the buffer (DEFAULT_BUFFER_SIZE = 32)
    expect(() => {
      for (let i = 0; i < 33; i++) {
        bus.publish(makeEvent(i));
      }
    }).toThrow(RunEventSubscriptionOverflowError);

    sub.close();
  });
});
