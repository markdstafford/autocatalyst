import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { sessionUsageSchema } from '@autocatalyst/api-contract';
import { ClaudeUsage } from './claude-usage.js';

const id = 'session';
const model = 'claude-served';
const raw = (input: number, read: number, writes: number, output: number, retention?: '5m' | '1h') => ({
  input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: writes, output_tokens: output,
  ...(retention === undefined ? {} : { cache_creation: { ['ephemeral_' + retention + '_input_tokens']: writes } })
});
const keyed = (inputTokens: number, cacheReadInputTokens: number, cacheCreationInputTokens: number, outputTokens: number) =>
  ({ [model]: { inputTokens, cacheReadInputTokens, cacheCreationInputTokens, outputTokens, contextWindow: 1000, costUSD: 900 } });
function init(resume = false) {
  const tracker = new ClaudeUsage(resume);
  tracker.observe({ type: 'system', subtype: 'init', session_id: id });
  return tracker;
}
function assistant(tracker: ClaudeUsage, request: string, usage: unknown, parent: string | null = null, content: unknown[] = []) {
  tracker.observe({ type: 'assistant', session_id: id, request_id: request, parent_tool_use_id: parent, message: { model, id: request, usage, content } });
}
function terminal(tracker: ClaudeUsage, evidence: object) {
  tracker.observe({ type: 'result', session_id: id, subtype: 'error_during_execution', ...evidence });
}

describe('Claude SDK accounting', () => {
  it('reconciles a linked closed child and no duplicate final/content blocks', () => {
    const tracker = init();
    assistant(tracker, 'a', raw(40, 60, 20, 10, '5m'), null, [{ type: 'tool_use', id: 'tool', name: 'Agent' }]);
    assistant(tracker, 'a', raw(40, 60, 20, 10, '5m'));
    assistant(tracker, 'b', raw(10, 20, 5, 4, '1h'), 'tool');
    terminal(tracker, { modelUsage: keyed(50, 80, 25, 14) });
    expect(tracker.evidence().usage?.coverage).toBe('partial');
    tracker.observe({ type: 'system', subtype: 'task_notification', session_id: id, task_id: 'task', tool_use_id: 'tool', status: 'completed' });
    expect(sessionUsageSchema.parse(tracker.evidence().usage)).toMatchObject({
      coverage: 'complete', totals: { freshInput: 50, cacheRead: 80, cacheWrite: 25, output: 14, cacheWriteByRetention: { '5m': 20, '1h': 5 } },
      groups: [{ requestInputTokens: 120 }, { requestInputTokens: 35 }]
    });
  });

  it('keeps the unkeyed residual once and retains scoped aggregate on contradiction', () => {
    const tracker = init();
    assistant(tracker, 'owned', raw(40, 60, 0, 10));
    terminal(tracker, { usage: raw(100, 100, 0, 20) });
    expect(tracker.evidence().usage).toMatchObject({
      coverage: 'complete', groups: [
        { model: { provider: 'anthropic', model }, requestInputTokens: 100 },
        { model: null, tokens: { freshInput: 60, cacheRead: 40, cacheWrite: 0, output: 10 }, requestInputTokens: null }
      ]
    });
    terminal(tracker, { usage: raw(10, 100, 0, 20) });
    expect(tracker.evidence().usage).toMatchObject({
      coverage: 'partial', groups: [{ model: null, tokens: { freshInput: 10 } }]
    });
  });

  it('uses SDK task linkage without double-counting child work from terminal totals', () => {
    const tracker = init();
    assistant(tracker, 'parent', raw(40, 60, 20, 10, '5m'));
    tracker.observe({ type: 'system', subtype: 'task_started', session_id: id, task_id: 'task',
      tool_use_id: 'tool', subagent_type: 'general-purpose' });
    assistant(tracker, 'child', raw(10, 20, 5, 4, '1h'), 'tool');
    terminal(tracker, { modelUsage: keyed(70, 80, 25, 14) });
    tracker.observe({ type: 'system', subtype: 'task_notification', session_id: id, task_id: 'task', status: 'completed' });
    expect(tracker.evidence().usage).toMatchObject({
      coverage: 'partial', totals: { freshInput: 50, cacheRead: 80, cacheWrite: 25, output: 14 },
      groups: [{ requestInputTokens: 120 }, { requestInputTokens: 35 }]
    });
    terminal(tracker, { modelUsage: keyed(50, 80, 25, 14) });
    expect(tracker.evidence().usage?.coverage).toBe('complete');
  });

  it('ignores replay and terminal cumulative totals on resume', () => {
    const tracker = init(true);
    tracker.observe({ type: 'assistant', session_id: id, isReplay: true, request_id: 'old', parent_tool_use_id: null,
      message: { model, usage: raw(500, 0, 0, 10) } });
    assistant(tracker, 'fresh', raw(40, 60, 20, 10));
    terminal(tracker, { modelUsage: keyed(540, 60, 20, 20) });
    expect(tracker.evidence().usage).toMatchObject({ coverage: 'partial', totals: { freshInput: 40 } });
  });

  it('compacts 5,000 owned exact requests to 256 groups while keeping totals and range bounds', () => {
    const tracker = init();
    for (let i = 1; i <= 5_000; i++) assistant(tracker, String(i), raw(i, 0, 0, 1));
    terminal(tracker, { modelUsage: keyed(12_502_500, 0, 0, 5_000) });
    const start = performance.now();
    const usage = sessionUsageSchema.parse(tracker.evidence().usage);
    expect(performance.now() - start).toBeLessThan(1000);
    expect(usage.coverage).toBe('complete');
    expect(usage.groups).toHaveLength(256);
    expect(usage.groups[0]?.requestInputRange).toEqual({ min: 1, max: 4745 });
    expect(usage.totals).toMatchObject({ freshInput: 12_502_500, output: 5_000 });
  });
});
