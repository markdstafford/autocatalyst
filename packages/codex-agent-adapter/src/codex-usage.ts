import type { BillingKey, UsageGroup } from '@autocatalyst/api-contract';
import {
  type AgentTokenUsage, compactUsageGroups, normalizeSessionUsage, openAIUsageTokens, usageCount, usageGroup, usageRecord
} from '@autocatalyst/execution';

const keys = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens'] as const;
const counters = (raw: unknown) => keys.map((key) => usageCount(usageRecord(raw)[key]));

interface Turn {
  readonly id: string;
  rerouted: boolean;
  child: boolean;
  updated: boolean;
  ended: boolean;
}
export type CodexAccountingAnomaly = 'counter_reset' | 'invalid_counter' | 'unexpected_cache_writes' | 'invalid_cache_split';
type Sample = { index: number; size: number };
interface Observation {
  group: UsageGroup;
  turns: Turn[];
  index: number;
}

/** Attempt-local accounting for the pinned app-server notifications. No opaque IDs escape this boundary. */
export class CodexUsage {
  readonly #model: BillingKey | null;
  readonly #resumed: boolean;
  readonly #turns = new Map<string, Turn>();
  readonly #observations: Observation[] = [];
  readonly #samples: Sample[] = [];
  #baseline: (number | null)[] | undefined;
  readonly #stopped = new Set<number>();
  #incomplete: boolean;
  #index = 0;
  #inclusive: bigint | null = null;
  #lastTurn: Turn | undefined;
  readonly anomalies = new Set<CodexAccountingAnomaly>();

  constructor(readonly threadId: string, model: BillingKey | null, resumed = false, baseline?: readonly (number | null)[]) {
    this.#model = model;
    this.#resumed = resumed;
    this.#incomplete = resumed && baseline === undefined;
    if (baseline) this.#baseline = [...baseline];
    else if (!resumed) this.#baseline = [0, 0, 0, 0];
  }

  baseline(): readonly (number | null)[] | undefined {
    return this.#lastTurn?.updated && this.#stopped.size === 0 ? this.#baseline : undefined;
  }

  ownTurn(id: string): void {
    if (!this.#turns.has(id)) this.#turns.set(id, { id, rerouted: false, child: false, updated: false, ended: false });
  }

  observe(method: unknown, raw: unknown): void {
    const params = usageRecord(raw);
    if (params['threadId'] !== this.threadId) return;
    const status = usageRecord(params['turn']);
    const id = method === 'turn/completed' ? status['id'] : params['turnId'];
    const turn = typeof id === 'string' ? this.#turns.get(id) : undefined;
    if (turn === undefined) return;
    if (method === 'turn/completed') {
      turn.ended = ['completed', 'failed', 'interrupted', 'cancelled'].includes(String(status['status']));
    } else if (method === 'model/rerouted') {
      turn.rerouted = true;
    } else if (method === 'item/started' || method === 'item/completed') {
      const item = usageRecord(params['item']);
      if (item['type'] === 'collabAgentToolCall' && item['senderThreadId'] === this.threadId &&
          Array.isArray(item['receiverThreadIds']) && item['receiverThreadIds'].some((child: unknown) =>
            typeof child === 'string' && child.length > 0 && child !== this.threadId)) turn.child = true;
    } else if (method === 'thread/tokenUsage/updated') {
      this.#update(turn, usageRecord(params['tokenUsage']));
    }
  }

  #update(turn: Turn, usage: Record<string, unknown>): void {
    for (const event of [usage['total'], usage['last']]) {
      const raw = usageRecord(event);
      if (keys.some((key) => raw[key] != null && usageCount(raw[key]) === null)) this.anomalies.add('invalid_counter');
    }
    const total = counters(usage['total']);
    const last = counters(usage['last']);
    const unexpectedWrites = [usage['total'], usage['last']].some((raw) =>
      (usageCount(usageRecord(raw)['cacheWriteInputTokens']) ?? 0) > 0);
    if (this.#baseline === undefined) {
      this.#baseline = total;
      this.#lastTurn = turn;
      return; // An owned resume update anchors the counter, but belongs to no chargeable delta.
    }
    const before = this.#baseline;
    if (unexpectedWrites) {
      this.#incomplete = true;
      this.anomalies.add('unexpected_cache_writes');
    }
    const replay = (this.#observations.length > 0 || this.#resumed) && total.every((n, i) => n === before[i]);
    if (replay) return;
    const delta = total.map((next, i) => {
      if (this.#stopped.has(i)) return null;
      const prior = before[i];
      if (next === null || prior == null) {
        // Re-anchoring after an unreadable counter loses a counter interval.
        // An independently valid later snapshot cannot make that invocation whole.
        if (i < 3) this.#incomplete = true;
        return null;
      }
      if (next < prior) {
        this.anomalies.add('counter_reset');
        if (i < 3) this.#incomplete = true;
        this.#stopped.add(i);
        return null;
      }
      return next - prior;
    });
    this.#baseline = total;
    const input = delta[0] ?? null;
    if (input !== null) this.#inclusive = (this.#inclusive ?? 0n) + BigInt(input);
    if (!delta.some((n) => n !== null)) return;
    const index = this.#index++;
    const sample = last[0] ?? null;
    const sampleValid = !unexpectedWrites && sample !== null && last[1] != null && last[1] <= sample &&
      last[2] != null && (last[3] == null || last[3] <= last[2]);
    const positive = delta.slice(0, 3).some((n) => n !== null && n > 0);
    const matchesLast = sampleValid && positive && delta.slice(0, 3).every((n, i) => n !== null && n === last[i]);
    if (input !== null && delta[1] != null && delta[1] > input) this.anomalies.add('invalid_cache_split');
    const tokens = openAIUsageTokens(input, delta[1] ?? null, delta[2] ?? null, delta[3] ?? null, unexpectedWrites);
    const seen = [...this.#turns.values()];
    const firstIndex = this.#lastTurn === undefined ? 0 : seen.indexOf(this.#lastTurn);
    const turnIndex = seen.indexOf(turn);
    if (turnIndex < firstIndex) this.#incomplete = true;
    const turns = seen.slice(Math.min(firstIndex, turnIndex), Math.max(firstIndex, turnIndex) + 1)
      .filter((candidate) => candidate === turn || !candidate.updated);
    if (turns.length > 1) this.#incomplete = true;
    turn.updated = true;
    this.#lastTurn = turn;
    const exact = matchesLast && turns.length === 1;
    // An unmatched last has no request ID to prove a separate owned sample. Only a verified
    // single-request delta can lend its size to a different, unsized observation.
    if (exact) this.#samples.push({ index, size: sample });
    this.#observations.push({ group: usageGroup(this.#model, tokens, exact, input), turns, index });
  }

  evidence(): AgentTokenUsage {
    const turns = [...this.#turns.values()];
    const child = turns.some((turn) => turn.child);
    const closed = !child && !this.#incomplete && turns.length > 0 && turns.every((turn) => turn.ended && turn.updated);
    const groups = this.#observations.map(({ group, index, turns: scope }) => {
      // A linked child can overlap parent counts beyond the notification that announced it.
      const ambiguous = child || scope.some((turn) => turn.rerouted) ||
        turns.slice(0, turns.indexOf(scope[0]!)).some((turn) => turn.rerouted);
      const nearest = group.requestInputTokens === null ? this.#samples.reduce<Sample | undefined>(
        (best, sample) => best === undefined || Math.abs(index - sample.index) < Math.abs(index - best.index) ? sample : best,
        undefined
      ) : undefined;
      return {
        ...group, model: ambiguous ? null : group.model,
        ...(nearest === undefined ? {} : { requestSizeHint: { method: 'nearest_sample' as const, inputTokens: nearest.size } })
      };
    });
    return normalizeSessionUsage(compactUsageGroups(groups), closed,
      this.#inclusive !== null && this.#inclusive <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(this.#inclusive) : null);
  }
}
