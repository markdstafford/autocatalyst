import { randomUUID } from 'node:crypto';
import {
  clientRunEventSchema,
  runStateTransitionEventSchema,
  type ClientRunEvent,
  type Run,
  type RunEventReplayResult,
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

// --- Store interfaces ---

export interface RunEventStoreScope {
  readonly runId: string;
  readonly tenant: string;
}

export interface AppendRunEventInput {
  readonly scope: RunEventStoreScope;
  readonly event: ClientRunEvent;
}

export interface ReplayRunEventsInput extends RunEventStoreScope {
  readonly lastEventId?: string;
}

export interface SubscribeRunEventsInput extends RunEventStoreScope {
  readonly lastEventId?: string;
}

export interface RunEventSubscription {
  readonly events: AsyncIterable<ClientRunEvent>;
  close(): void;
}

export interface RunEventStore {
  append(input: AppendRunEventInput): Promise<void>;
  replayAfter(input: ReplayRunEventsInput): Promise<RunEventReplayResult>;
  subscribe(input: SubscribeRunEventsInput): RunEventSubscription;
}

// Backwards-compatible publisher/subscriber aliases.
export type RunEventPublisher = RunEventStore;
export type RunEventSubscriber = Pick<RunEventStore, 'subscribe'>;
export type RunEventBus = RunEventStore;

export interface RetainedRunEventStoreOptions {
  readonly maxEventsPerScope?: number;
  readonly maxExpiredIdsPerScope?: number;
  readonly subscriberBufferSize?: number;
  readonly clock?: () => string;
}

export class RunEventSubscriptionOverflowError extends Error {
  constructor() {
    super('Run event subscription buffer overflow.');
    this.name = 'RunEventSubscriptionOverflowError';
  }
}

const DEFAULT_MAX_EVENTS = 256;
const DEFAULT_MAX_EXPIRED_IDS = 256;
const DEFAULT_SUBSCRIBER_BUFFER = 64;

interface ScopeState {
  readonly events: ClientRunEvent[];
  readonly expiredIds: Set<string>;
  readonly expiredIdOrder: string[];
  readonly subscribers: Set<Subscriber>;
}

export class InMemoryRetainedRunEventStore implements RunEventStore {
  readonly #scopes = new Map<string, ScopeState>();
  readonly #maxEvents: number;
  readonly #maxExpiredIds: number;
  readonly #subscriberBufferSize: number;

  constructor(options: RetainedRunEventStoreOptions = {}) {
    this.#maxEvents = options.maxEventsPerScope ?? DEFAULT_MAX_EVENTS;
    this.#maxExpiredIds = options.maxExpiredIdsPerScope ?? DEFAULT_MAX_EXPIRED_IDS;
    this.#subscriberBufferSize = options.subscriberBufferSize ?? DEFAULT_SUBSCRIBER_BUFFER;
  }

  async append(input: AppendRunEventInput): Promise<void> {
    const validated = clientRunEventSchema.parse(input.event);
    if (validated.runId !== input.scope.runId) {
      throw new Error(`Event runId '${validated.runId}' does not match scope runId '${input.scope.runId}'.`);
    }
    const key = this.#scopeKey(input.scope);
    const state = this.#getOrCreate(key);
    state.events.push(validated);
    if (state.events.length > this.#maxEvents) {
      const evicted = state.events.shift();
      if (evicted !== undefined) {
        this.#recordExpired(state, evicted.id);
      }
    }
    for (const sub of [...state.subscribers]) {
      try {
        sub.push(validated);
      } catch {
        sub.close();
        state.subscribers.delete(sub);
      }
    }
  }

  async replayAfter(input: ReplayRunEventsInput): Promise<RunEventReplayResult> {
    const key = this.#scopeKey(input);
    const state = this.#scopes.get(key);
    if (input.lastEventId === undefined) {
      return { status: 'ok', events: [] };
    }
    if (state === undefined) {
      return { status: 'unknown_event_id', lastEventId: input.lastEventId };
    }
    const cursorIndex = state.events.findIndex((event) => event.id === input.lastEventId);
    if (cursorIndex >= 0) {
      const events = state.events.slice(cursorIndex + 1);
      return { status: 'ok', events };
    }
    if (state.expiredIds.has(input.lastEventId)) {
      return { status: 'expired_event_id', lastEventId: input.lastEventId };
    }
    return { status: 'unknown_event_id', lastEventId: input.lastEventId };
  }

  subscribe(input: SubscribeRunEventsInput): RunEventSubscription {
    const key = this.#scopeKey(input);
    const state = this.#getOrCreate(key);
    const sub = new Subscriber(this.#subscriberBufferSize);
    state.subscribers.add(sub);
    return {
      events: sub.iterable(),
      close: () => {
        sub.close();
        state.subscribers.delete(sub);
      }
    };
  }

  #scopeKey(scope: RunEventStoreScope): string {
    return `${scope.tenant}${scope.runId}`;
  }

  #getOrCreate(key: string): ScopeState {
    let state = this.#scopes.get(key);
    if (state === undefined) {
      state = { events: [], expiredIds: new Set(), expiredIdOrder: [], subscribers: new Set() };
      this.#scopes.set(key, state);
    }
    return state;
  }

  #recordExpired(state: ScopeState, id: string): void {
    if (state.expiredIds.has(id)) return;
    state.expiredIds.add(id);
    state.expiredIdOrder.push(id);
    while (state.expiredIdOrder.length > this.#maxExpiredIds) {
      const removed = state.expiredIdOrder.shift();
      if (removed !== undefined) state.expiredIds.delete(removed);
    }
  }
}

class Subscriber {
  readonly #bufferSize: number;
  #closed = false;
  #buffer: ClientRunEvent[] = [];
  #resolve: ((value: IteratorResult<ClientRunEvent>) => void) | null = null;

  constructor(bufferSize: number) {
    this.#bufferSize = bufferSize;
  }

  push(event: ClientRunEvent): void {
    if (this.#closed) return;
    if (this.#resolve !== null) {
      const resolve = this.#resolve;
      this.#resolve = null;
      resolve({ value: event, done: false });
      return;
    }
    if (this.#buffer.length >= this.#bufferSize) {
      throw new RunEventSubscriptionOverflowError();
    }
    this.#buffer.push(event);
  }

  close(): void {
    this.#closed = true;
    if (this.#resolve !== null) {
      const resolve = this.#resolve;
      this.#resolve = null;
      resolve({ value: undefined as unknown as ClientRunEvent, done: true });
    }
  }

  iterable(): AsyncIterable<ClientRunEvent> {
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<ClientRunEvent> => ({
        next: (): Promise<IteratorResult<ClientRunEvent>> => {
          if (this.#buffer.length > 0) {
            return Promise.resolve({ value: this.#buffer.shift()!, done: false });
          }
          if (this.#closed) {
            return Promise.resolve({ value: undefined as unknown as ClientRunEvent, done: true });
          }
          return new Promise<IteratorResult<ClientRunEvent>>((resolve) => {
            this.#resolve = resolve;
          });
        },
        return: (): Promise<IteratorResult<ClientRunEvent>> => {
          this.close();
          return Promise.resolve({ value: undefined as unknown as ClientRunEvent, done: true });
        }
      })
    };
  }
}

// --- Backwards-compatible InMemoryRunEventBus shim (deprecated) ---
// Thin alias kept only so existing tests compile without churn.
// Use InMemoryRetainedRunEventStore directly in new code.
export class InMemoryRunEventBus implements RunEventStore {
  readonly #store: InMemoryRetainedRunEventStore;

  constructor(options: RetainedRunEventStoreOptions = {}) {
    this.#store = new InMemoryRetainedRunEventStore(options);
  }

  async append(input: AppendRunEventInput): Promise<void> {
    await this.#store.append(input);
  }

  async replayAfter(input: ReplayRunEventsInput): Promise<RunEventReplayResult> {
    return this.#store.replayAfter(input);
  }

  subscribe(input: SubscribeRunEventsInput): RunEventSubscription {
    return this.#store.subscribe(input);
  }
}
