import { hasMeasuredUsage, usageTokenClasses, type UsageGroup, type UsageTokens } from '@autocatalyst/api-contract';
import {
  anthropicUsageTokens, compactUsageGroups, normalizeSessionUsage, usageBillingKey, usageGroup, usageRecord,
  type NativeUsageAnomaly
} from '@autocatalyst/execution';

const text = (value: unknown) => typeof value === 'string' && value.length > 0 ? value : undefined;
type Request = { group: UsageGroup; parent: string | null; childTools: string[] };
type Task = { tool?: string; closed: boolean; subagent: boolean };
export type ClaudeAccountingAnomaly = NativeUsageAnomaly | 'aggregate_overlap';

function residual(total: UsageTokens, requests: readonly UsageGroup[]): UsageTokens | null {
  const remaining = { ...total };
  for (const name of usageTokenClasses) {
    const count = total[name];
    if (typeof count !== 'number') return null;
    let difference = BigInt(count);
    for (const { tokens } of requests) {
      if (typeof tokens[name] !== 'number') return null;
      difference -= BigInt(tokens[name]);
    }
    if (difference < 0n) return null;
    remaining[name] = Number(difference);
  }
  // An aggregate and its final requests don't necessarily use the same retention detail.
  // Keep an independently reported split only when none of that aggregate was subtracted.
  if (requests.length > 0) delete remaining.cacheWriteByRetention;
  return remaining;
}

function hasPositive(tokens: UsageTokens): boolean {
  return usageTokenClasses.some((name) => typeof tokens[name] === 'number' && tokens[name] > 0);
}

export class ClaudeUsage {
  #sessionId: string | undefined;
  readonly #requests = new Map<string, Request>();
  readonly #messageAliases = new Map<string, string | null>();
  readonly #tasks = new Map<string, Task>();
  #result: Record<string, unknown> | undefined;
  #replayed = false;
  #uncertain = false;
  readonly anomalies = new Set<ClaudeAccountingAnomaly>();

  constructor(readonly resumed: boolean) {}

  bindRoot(id: string): void { this.#sessionId ??= id; }

  observe(raw: unknown): void {
    const msg = usageRecord(raw);
    const type = msg['type'];
    const subtype = msg['subtype'];
    const sessionId = text(msg['session_id']);
    if (sessionId === undefined) return;
    if (type === 'system' && subtype === 'init') {
      this.#sessionId ??= sessionId;
      return;
    }
    if (msg['isReplay'] === true || msg['is_replay'] === true) {
      this.#replayed = true;
      return;
    }
    if (this.#sessionId === undefined && !this.resumed && type === 'assistant' && msg['parent_tool_use_id'] === null) this.#sessionId = sessionId;
    if (this.#sessionId === undefined || sessionId !== this.#sessionId) return;
    if (type === 'result') {
      this.#result = msg;
      return;
    }
    if (type === 'system' && ['task_started', 'task_progress', 'task_notification'].includes(String(subtype))) {
      const taskId = text(msg['task_id']);
      if (taskId === undefined) return;
      const prior = this.#tasks.get(taskId);
      const tool = text(msg['tool_use_id']) ?? prior?.tool;
      this.#tasks.set(taskId, {
        ...(tool === undefined ? {} : { tool }),
        subagent: prior?.subagent === true || text(msg['subagent_type']) !== undefined || msg['task_type'] === 'local_agent',
        closed: prior?.closed === true || (subtype === 'task_notification' && ['completed', 'failed', 'stopped'].includes(String(msg['status'])))
      });
      return;
    }
    if (type !== 'assistant') return;
    const parent = msg['parent_tool_use_id'] === null ? null : text(msg['parent_tool_use_id']);
    if (parent === undefined) return;
    const message = usageRecord(msg['message']);
    const request = text(msg['request_id']);
    const messageId = text(message['id']);
    const fallback = messageId === undefined ? undefined : JSON.stringify([sessionId, parent, messageId]);
    const nativeKey = request === undefined ? undefined : JSON.stringify([sessionId, request]);
    const alias = fallback === undefined ? undefined : this.#messageAliases.get(fallback);
    const key = nativeKey ?? (alias === null ? undefined : alias ?? fallback);
    if (nativeKey !== undefined && fallback !== undefined) {
      // A content-block record may omit the request ID even when another record
      // for this same native message includes it. Never join two distinct IDs.
      if (alias === undefined) {
        const prior = this.#requests.get(fallback);
        if (prior !== undefined) {
          if (!this.#requests.has(nativeKey)) this.#requests.set(nativeKey, prior);
          this.#requests.delete(fallback);
        }
        this.#messageAliases.set(fallback, nativeKey);
      } else if (alias !== nativeKey) this.#messageAliases.set(fallback, null);
    }
    const tokens = this.#tokens(message['usage']);
    if (key === undefined) {
      if (hasMeasuredUsage(tokens)) this.#uncertain = true;
      return;
    }
    const childTools = Array.isArray(message['content']) ? message['content'].flatMap((rawBlock: unknown) => {
      const block = usageRecord(rawBlock);
      const id = text(block['id']);
      return block['type'] === 'tool_use' && ['Agent', 'Task'].includes(String(block['name'])) && id !== undefined ? [id] : [];
    }) : [];
    const prior = this.#requests.get(key);
    const model = usageBillingKey('anthropic', message['model']);
    const group = usageGroup(model, tokens, true);
    // A request can be delivered as multiple assistant content blocks. Replace with
    // the last validated observation, not an extra request, and retain linkage.
    this.#requests.set(key, {
      group: hasMeasuredUsage(tokens) || prior === undefined ? group : prior.group,
      parent, childTools: [...new Set([...(prior?.childTools ?? []), ...childTools])]
    });
  }

  #tokens(value: unknown, keyed = false): UsageTokens {
    return anthropicUsageTokens(value, keyed, (code) => this.anomalies.add(code));
  }

  evidence() {
    const linked = new Set<string>();
    const work: UsageGroup[] = [];
    const requests = [...this.#requests.values()];
    const childrenWithCounts = new Set<string>();
    // Parent tool linkage, not model or task output, proves child ownership.
    let pending = requests;
    const tasks = [...this.#tasks.values()];
    // The active SDK session can announce subagents through task lifecycle
    // messages even when the parent tool-use assistant block is absent.
    for (const task of tasks) {
      if (task.subagent && task.tool !== undefined) linked.add(task.tool);
    }
    while (pending.length > 0) {
      const next: Request[] = [];
      for (const request of pending) {
        if (request.parent !== null && !linked.has(request.parent)) {
          next.push(request);
          continue;
        }
        for (const tool of request.childTools) linked.add(tool);
        if (hasMeasuredUsage(request.group.tokens)) {
          work.push(request.group);
          if (request.parent !== null) childrenWithCounts.add(request.parent);
        }
      }
      if (pending.length === next.length) break;
      pending = next;
    }

    const terminal = this.#result;
    if (this.resumed || this.#replayed || terminal === undefined) {
      return normalizeSessionUsage(compactUsageGroups(work), false);
    }
    const modelUsage = usageRecord(terminal['modelUsage']);
    const keyed = Object.entries(modelUsage).flatMap(([name, raw]) => {
      const tokens = this.#tokens(raw, true);
      const model = usageBillingKey('anthropic', name);
      return hasMeasuredUsage(tokens) && model !== null ? [usageGroup(model, tokens, false)] : [];
    });
    const scopedUsage = this.#tokens(terminal['usage']);
    const unlinkedTask = tasks.some((task) => task.subagent && task.tool === undefined);
    if (linked.size > 0 || pending.length > 0 || unlinkedTask) {
      const closedChildren = !unlinkedTask && pending.length === 0 && [...linked].every((tool) =>
        childrenWithCounts.has(tool) && tasks.some((task) => task.tool === tool && task.closed));
      const reconciled = keyed.length > 0 &&
        work.every(({ model }) => model !== null && keyed.some((entry) => entry.model?.model === model.model)) &&
        keyed.every((entry) => {
          const difference = residual(entry.tokens, work.filter(({ model }) => model?.model === entry.model?.model));
          return difference !== null && !hasPositive(difference);
        });
      return normalizeSessionUsage(compactUsageGroups(work), !this.#uncertain && closedChildren && reconciled);
    }
    const attachHint = (group: UsageGroup): UsageGroup => {
      // Without a join to an observation position, use only the largest sample
      // from the same active parent thread. This does not constrain its bands.
      const largest = work.reduce((maximum, request) => Math.max(maximum, request.requestInputTokens ?? -1), -1);
      return largest < 0 ? group : { ...group, requestSizeHint: { method: 'largest_sample', inputTokens: largest } };
    };
    if (keyed.length > 0) {
      const allAttributed = work.every(({ model }) => model !== null && keyed.some((entry) => entry.model?.model === model.model));
      const reconciled = keyed.map((entry) => {
        const finals = work.filter(({ model }) => model?.model === entry.model?.model);
        const difference = residual(entry.tokens, finals);
        return { entry, difference, finals };
      });
      if (!allAttributed || reconciled.some(({ difference, finals }) => difference === null && finals.length > 0)) {
        this.anomalies.add('aggregate_overlap');
        return normalizeSessionUsage(keyed, false);
      }
      const remainder = reconciled.flatMap(({ entry, difference, finals }) =>
        finals.length === 0 ? [attachHint(entry)] : difference !== null && hasPositive(difference)
          ? [attachHint(usageGroup(entry.model, difference, false))] : []);
      return normalizeSessionUsage(compactUsageGroups([...work, ...remainder]), !this.#uncertain && keyed.length === Object.keys(modelUsage).length);
    }
    if (hasMeasuredUsage(scopedUsage)) {
      const difference = residual(scopedUsage, work);
      if (difference === null && work.length > 0) {
        this.anomalies.add('aggregate_overlap');
        return normalizeSessionUsage([usageGroup(null, scopedUsage, false)], false);
      }
      const groups = work.length === 0 ? [usageGroup(null, scopedUsage, false)] :
        difference !== null && hasPositive(difference) ? [...work, attachHint(usageGroup(null, difference, false))] : work;
      return normalizeSessionUsage(compactUsageGroups(groups), !this.#uncertain);
    }
    return normalizeSessionUsage(compactUsageGroups(work), false);
  }
}
