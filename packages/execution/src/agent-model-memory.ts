import type { JsonValue } from '@autocatalyst/api-contract';

export interface AgentModelMemorySnapshot {
  readonly providerKind: string;
  readonly adapterId: string;
  readonly state: JsonValue;
}

export interface AgentModelMemoryStore {
  load(): Promise<AgentModelMemorySnapshot | null>;
  save(snapshot: AgentModelMemorySnapshot): Promise<void>;
}

export interface AgentModelMemoryContinuity {
  /** Stable logical conversation key, not a sandbox/session identifier. */
  readonly key: string;
  readonly store: AgentModelMemoryStore;
}

export function createNoopAgentModelMemoryStore(): AgentModelMemoryStore {
  return {
    async load(): Promise<AgentModelMemorySnapshot | null> { return null; },
    async save(_snapshot: AgentModelMemorySnapshot): Promise<void> { return undefined; }
  };
}
