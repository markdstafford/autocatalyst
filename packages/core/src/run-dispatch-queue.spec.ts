import { describe, expect, it } from 'vitest';
import { RunDispatchQueue } from './run-dispatch-queue.js';

describe('RunDispatchQueue constructor', () => {
  it('rejects maxConcurrent of 0', () => {
    expect(() => new RunDispatchQueue({ maxConcurrent: 0 })).toThrow(
      'maxConcurrent must be a positive integer, got 0.'
    );
  });

  it('rejects maxConcurrent of -1', () => {
    expect(() => new RunDispatchQueue({ maxConcurrent: -1 })).toThrow(
      'maxConcurrent must be a positive integer, got -1.'
    );
  });

  it('rejects non-integer maxConcurrent (1.5)', () => {
    expect(() => new RunDispatchQueue({ maxConcurrent: 1.5 })).toThrow(
      'maxConcurrent must be a positive integer, got 1.5.'
    );
  });

  it('accepts positive integer maxConcurrent', () => {
    expect(() => new RunDispatchQueue({ maxConcurrent: 1 })).not.toThrow();
    expect(() => new RunDispatchQueue({ maxConcurrent: 5 })).not.toThrow();
  });
});

describe('RunDispatchQueue enqueue', () => {
  it('runs immediate work when under cap', async () => {
    const queue = new RunDispatchQueue({ maxConcurrent: 2 });
    let ran = false;
    await queue.enqueue(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it('never exceeds maxConcurrent', async () => {
    const queue = new RunDispatchQueue({ maxConcurrent: 2 });

    const resolvers: Array<() => void> = [];
    const jobs = [0, 1, 2].map(() => {
      return () =>
        new Promise<void>((resolve) => {
          resolvers.push(resolve);
        });
    });

    const p0 = queue.enqueue(jobs[0]!);
    const p1 = queue.enqueue(jobs[1]!);
    const p2 = queue.enqueue(jobs[2]!);

    // Flush microtasks so work() callbacks execute and resolvers are populated
    await Promise.resolve();

    // First 2 should be active, 1 queued
    expect(queue.activeCount).toBe(2);
    expect(queue.queuedCount).toBe(1);

    // Complete first job
    resolvers[0]!();
    await p0;
    // Flush microtask so .finally() runs (draining the queue and starting job[2])
    await Promise.resolve();

    // Now 2 should be active (jobs[1] still running, jobs[2] started), 0 queued
    expect(queue.activeCount).toBe(2);
    expect(queue.queuedCount).toBe(0);

    // Flush microtasks so job[2]'s work() runs and resolver[2] is populated
    await Promise.resolve();

    resolvers[1]!();
    await p1;
    // Flush so resolver[2] is populated (drained job's work() needs a tick)
    await Promise.resolve();
    await Promise.resolve();

    resolvers[2]!();
    await p2;
    // Flush so .finally() on p2 runs and activeCount decrements
    await Promise.resolve();

    expect(queue.activeCount).toBe(0);
  });

  it('queued jobs start after in-flight completes (success)', async () => {
    const queue = new RunDispatchQueue({ maxConcurrent: 1 });
    const order: number[] = [];

    let resolveFirst!: () => void;
    const first = queue.enqueue(
      () =>
        new Promise<void>((resolve) => {
          resolveFirst = resolve;
        })
    );

    const second = queue.enqueue(async () => {
      order.push(2);
    });

    // Flush microtasks so work() callbacks execute and resolveFirst is populated
    await Promise.resolve();

    expect(queue.activeCount).toBe(1);
    expect(queue.queuedCount).toBe(1);

    order.push(1);
    resolveFirst();
    await first;
    await second;
    // Flush microtasks so .finally() on 'second' runs and activeCount decrements
    await Promise.resolve();

    expect(order).toEqual([1, 2]);
    expect(queue.activeCount).toBe(0);
    expect(queue.queuedCount).toBe(0);
  });

  it('queued jobs start after in-flight fails (failure case)', async () => {
    const queue = new RunDispatchQueue({ maxConcurrent: 1 });
    let secondRan = false;

    let rejectFirst!: (err: Error) => void;
    const first = queue.enqueue(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectFirst = reject;
        })
    );

    const second = queue.enqueue(async () => {
      secondRan = true;
    });

    // Flush microtasks so work() callbacks execute and rejectFirst is populated
    await Promise.resolve();

    expect(queue.activeCount).toBe(1);
    expect(queue.queuedCount).toBe(1);

    rejectFirst(new Error('boom'));
    await expect(first).rejects.toThrow('boom');
    await second;

    expect(secondRan).toBe(true);
    expect(queue.activeCount).toBe(0);
  });

  it('FIFO order — queued jobs start in the order they were enqueued', async () => {
    const queue = new RunDispatchQueue({ maxConcurrent: 1 });
    const order: number[] = [];

    let resolveFirst!: () => void;
    const first = queue.enqueue(
      () =>
        new Promise<void>((resolve) => {
          resolveFirst = resolve;
        })
    );

    const second = queue.enqueue(async () => {
      order.push(2);
    });
    const third = queue.enqueue(async () => {
      order.push(3);
    });
    const fourth = queue.enqueue(async () => {
      order.push(4);
    });

    // Flush microtasks so work() callback executes and resolveFirst is populated
    await Promise.resolve();

    resolveFirst();
    await first;
    await second;
    await third;
    await fourth;

    expect(order).toEqual([2, 3, 4]);
  });

  it('activeCount and queuedCount report correct state', async () => {
    const queue = new RunDispatchQueue({ maxConcurrent: 2 });
    expect(queue.activeCount).toBe(0);
    expect(queue.queuedCount).toBe(0);

    const resolvers: Array<() => void> = [];
    const makeJob = () =>
      () =>
        new Promise<void>((resolve) => {
          resolvers.push(resolve);
        });

    const p0 = queue.enqueue(makeJob());
    expect(queue.activeCount).toBe(1);
    expect(queue.queuedCount).toBe(0);

    const p1 = queue.enqueue(makeJob());
    expect(queue.activeCount).toBe(2);
    expect(queue.queuedCount).toBe(0);

    const p2 = queue.enqueue(makeJob());
    expect(queue.activeCount).toBe(2);
    expect(queue.queuedCount).toBe(1);

    const p3 = queue.enqueue(makeJob());
    // Flush microtasks so work() callbacks execute and resolvers are populated
    await Promise.resolve();

    expect(queue.activeCount).toBe(2);
    expect(queue.queuedCount).toBe(2);

    resolvers[0]!();
    await p0;
    // Two flushes: one for .finally() to run (drain+activeCount--), one for drained job's work()
    await Promise.resolve();
    await Promise.resolve();
    expect(queue.activeCount).toBe(2);
    expect(queue.queuedCount).toBe(1);

    resolvers[1]!();
    await p1;
    await Promise.resolve();
    await Promise.resolve();
    expect(queue.activeCount).toBe(2);
    expect(queue.queuedCount).toBe(0);

    resolvers[2]!();
    await p2;
    await Promise.resolve();
    await Promise.resolve();
    expect(queue.activeCount).toBe(1);
    expect(queue.queuedCount).toBe(0);

    resolvers[3]!();
    await p3;
    await Promise.resolve();
    expect(queue.activeCount).toBe(0);
    expect(queue.queuedCount).toBe(0);
  });
});
