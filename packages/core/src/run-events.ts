import { randomUUID } from 'node:crypto';
import {
  runStateTransitionEventSchema,
  type Run,
  type RunStateTransitionEvent,
  type RunStateTransitionKind,
  type RunStep
} from '@autocatalyst/api-contract';

// --- Event construction ---

export interface CreateRunStateTransitionEventInput {
  readonly runId: string;
  readonly directive: RunStateTransitionKind;
  readonly fromStep?: string;
  readonly toStep: string;
  readonly run: Run;
  readonly runStep: RunStep;
  readonly tenant: string;
  readonly idGenerator?: () => string;
  readonly clock?: () => string;
}

export function createRunStateTransitionEvent(input: CreateRunStateTransitionEventInput): RunStateTransitionEvent {
  const id = input.idGenerator?.() ?? `evt_${randomUUID()}`;
  const createdAt = input.clock?.() ?? new Date().toISOString();
  return runStateTransitionEventSchema.parse({
    id,
    type: 'run_state_transition',
    runId: input.runId,
    transition: {
      directive: input.directive,
      ...(input.fromStep !== undefined ? { fromStep: input.fromStep } : {}),
      toStep: input.toStep
    },
    run: input.run,
    runStep: input.runStep,
    tenant: input.tenant,
    createdAt
  });
}

// --- Event bus interfaces ---

export interface SubscribeRunEventsInput {
  readonly runId: string;
  readonly tenant: string;
  readonly lastEventId?: string; // live-memory-only; no durable replay for this issue
}

export interface RunEventSubscription {
  readonly events: AsyncIterable<RunStateTransitionEvent>;
  close(): void;
}

export interface RunEventPublisher {
  publish(event: RunStateTransitionEvent): void;
}

export interface RunEventSubscriber {
  subscribe(input: SubscribeRunEventsInput): RunEventSubscription;
}

export interface RunEventBus extends RunEventPublisher, RunEventSubscriber {}

// --- In-memory implementation ---

const DEFAULT_BUFFER_SIZE = 32;

export class RunEventSubscriptionOverflowError extends Error {
  constructor() {
    super('Run event subscription buffer overflow.');
    this.name = 'RunEventSubscriptionOverflowError';
  }
}

export class InMemoryRunEventBus implements RunEventBus {
  readonly #subscribers = new Map<string, Set<Subscriber>>();

  publish(event: RunStateTransitionEvent): void {
    const key = `${event.runId}:${event.tenant}`;
    const subs = this.#subscribers.get(key);
    if (subs === undefined) return;
    for (const sub of subs) {
      sub.push(event);
    }
  }

  subscribe(input: SubscribeRunEventsInput): RunEventSubscription {
    const key = `${input.runId}:${input.tenant}`;
    const sub = new Subscriber();
    if (!this.#subscribers.has(key)) {
      this.#subscribers.set(key, new Set());
    }
    this.#subscribers.get(key)!.add(sub);

    return {
      events: sub.iterable(),
      close: () => {
        sub.close();
        const set = this.#subscribers.get(key);
        if (set !== undefined) {
          set.delete(sub);
          if (set.size === 0) {
            this.#subscribers.delete(key);
          }
        }
      }
    };
  }
}

class Subscriber {
  #closed = false;
  #buffer: RunStateTransitionEvent[] = [];
  #resolve: ((value: IteratorResult<RunStateTransitionEvent>) => void) | null = null;

  push(event: RunStateTransitionEvent): void {
    if (this.#closed) return;
    if (this.#resolve !== null) {
      const resolve = this.#resolve;
      this.#resolve = null;
      resolve({ value: event, done: false });
      return;
    }
    if (this.#buffer.length >= DEFAULT_BUFFER_SIZE) {
      this.#closed = true;
      throw new RunEventSubscriptionOverflowError();
    }
    this.#buffer.push(event);
  }

  close(): void {
    this.#closed = true;
    if (this.#resolve !== null) {
      const resolve = this.#resolve;
      this.#resolve = null;
      resolve({ value: undefined as unknown as RunStateTransitionEvent, done: true });
    }
  }

  iterable(): AsyncIterable<RunStateTransitionEvent> {
    const self = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<RunStateTransitionEvent> {
        return {
          next(): Promise<IteratorResult<RunStateTransitionEvent>> {
            if (self.#buffer.length > 0) {
              return Promise.resolve({ value: self.#buffer.shift()!, done: false });
            }
            if (self.#closed) {
              return Promise.resolve({ value: undefined as unknown as RunStateTransitionEvent, done: true });
            }
            return new Promise<IteratorResult<RunStateTransitionEvent>>((resolve) => {
              self.#resolve = resolve;
            });
          },
          return(): Promise<IteratorResult<RunStateTransitionEvent>> {
            self.close();
            return Promise.resolve({ value: undefined as unknown as RunStateTransitionEvent, done: true });
          }
        };
      }
    };
  }
}
