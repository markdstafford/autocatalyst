import type { JsonValue } from '@autocatalyst/api-contract';
import type { AgentModelMemoryStore, AgentModelMemorySnapshot } from '@autocatalyst/execution';
import type { RunStepRepository } from './domain-repositories.js';

export interface AgentModelMemoryKeyInput {
  readonly runId: string;
  readonly step: string;
  readonly role: string;
  readonly providerKind: string;
  readonly adapterId: string;
  readonly profileName: string;
}

/**
 * Derives a stable, provider-neutral key for identifying a model-memory slot.
 * Format: {runId}:{step}:{role}:{providerKind}:{adapterId}:{profileName}
 * This key must never include session/sandbox identifiers.
 */
export function deriveAgentModelMemoryKey(input: AgentModelMemoryKeyInput): string {
  return `${input.runId}:${input.step}:${input.role}:${input.providerKind}:${input.adapterId}:${input.profileName}`;
}

export interface RunStepAgentModelMemoryStoreInput {
  readonly runSteps: RunStepRepository;
  readonly runId: string;
  readonly tenant: string;
  readonly currentStep: string;
  readonly key: string;
}

/**
 * Creates an AgentModelMemoryStore backed by run-step checkpoints.
 * Memory is stored in `checkpointResult.providerModelMemory[key]` and merged
 * with any existing checkpoint data.
 */
export function createRunStepAgentModelMemoryStore(input: RunStepAgentModelMemoryStoreInput): AgentModelMemoryStore {
  return {
    async load(): Promise<AgentModelMemorySnapshot | null> {
      const steps = await input.runSteps.listByRun(input.runId);
      // Find the latest RunStep for the current step (reverse order)
      const matching = [...steps].reverse().find(s => s.step === input.currentStep);
      if (matching === undefined) return null;
      const checkpoint = matching.checkpointResult;
      if (checkpoint === null || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) return null;
      const pmem = (checkpoint as Record<string, unknown>)['providerModelMemory'];
      if (pmem === null || typeof pmem !== 'object' || Array.isArray(pmem)) return null;
      const entry = (pmem as Record<string, unknown>)[input.key];
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null;
      const snap = entry as Record<string, unknown>;
      if (typeof snap['providerKind'] !== 'string' || typeof snap['adapterId'] !== 'string') return null;
      if (snap['state'] === undefined) return null;
      return {
        providerKind: snap['providerKind'],
        adapterId: snap['adapterId'],
        state: snap['state'] as JsonValue
      };
    },

    async save(snapshot: AgentModelMemorySnapshot): Promise<void> {
      const steps = await input.runSteps.listByRun(input.runId);
      // Find the latest RunStep for the current step
      const matching = [...steps].reverse().find(s => s.step === input.currentStep);
      if (matching === undefined) return;

      const existing = matching.checkpointResult;
      let merged: Record<string, unknown>;

      if (existing === null) {
        merged = { providerModelMemory: { [input.key]: snapshot } };
      } else if (typeof existing === 'object' && !Array.isArray(existing)) {
        const existingObj = existing as Record<string, unknown>;
        const existingPmem = existingObj['providerModelMemory'];
        const existingPmemObj =
          existingPmem !== null && typeof existingPmem === 'object' && !Array.isArray(existingPmem)
            ? (existingPmem as Record<string, unknown>)
            : {};
        merged = {
          ...existingObj,
          providerModelMemory: { ...existingPmemObj, [input.key]: snapshot }
        };
      } else {
        // Non-null primitive or array — wrap it
        merged = { previousCheckpoint: existing, providerModelMemory: { [input.key]: snapshot } };
      }

      await input.runSteps.updateCheckpoint({
        runStepId: matching.id,
        runId: input.runId,
        tenant: input.tenant,
        checkpointResult: merged as JsonValue
      });
    }
  };
}
