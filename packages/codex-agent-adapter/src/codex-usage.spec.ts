import { describe, expect, it } from 'vitest';
import { sessionUsageSchema } from '@autocatalyst/api-contract';
import { CodexUsage } from './codex-usage.js';

const key = { provider: 'openai', model: 'served' };
const update = (tracker: CodexUsage, turnId: string, counts: number[], sample?: number[], threadId = 'parent') => {
  const wire = ([inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens]: number[]) =>
    ({ inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens });
  tracker.observe('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { total: wire(counts), last: sample && wire(sample) } });
};
const complete = (tracker: CodexUsage, turn: string, status = 'completed') =>
  tracker.observe('turn/completed', { threadId: 'parent', turn: { id: turn, status } });

describe('Codex pinned accounting', () => {
  it('anchors resumed usage and ignores baseline/replay samples', () => {
    const tracker = new CodexUsage('parent', key, true);
    tracker.ownTurn('first');
    update(tracker, 'first', [1000, 600, 100, 40], [800, 500, 99, 20]);
    expect(tracker.evidence().usage).toMatchObject({ coverage: 'unavailable', groups: [] });
    update(tracker, 'first', [1100, 660, 110, 44], [100, 60, 10, 4]);
    update(tracker, 'first', [1100, 660, 110, 44], [999, 1, 1, 1]);
    complete(tracker, 'first');
    expect(sessionUsageSchema.parse(tracker.evidence().usage)).toMatchObject({
      coverage: 'partial', totals: { freshInput: 40, cacheRead: 60, output: 10, reasoningOutput: 4 },
      groups: [{ requestInputTokens: 100, model: key }]
    });
  });

  it('uses owned deltas, retains only proved counts on reset, and never adds last', () => {
    const tracker = new CodexUsage('parent', key);
    tracker.ownTurn('a');
    update(tracker, 'a', [160, 60, 10, 4], [120, 20, 2, 1]);
    update(tracker, 'a', [160, 60, 10, 4], [200, 100, 20, 1]);
    update(tracker, 'a', [500, 300, 100, 2], undefined, 'unrelated');
    complete(tracker, 'a');
    expect(tracker.evidence().usage).toMatchObject({ coverage: 'complete', groups: [
      { requestInputTokens: null, inputTotalCeilingTokens: 160, requestSizeHint: { method: 'nearest_sample', inputTokens: 120 } }
    ] });
    tracker.ownTurn('b');
    update(tracker, 'b', [200, 80, 20, 6], [40, 20, 10, 2]);
    update(tracker, 'b', [10, 5, 21, 7], [10, 5, 1, 1]);
    complete(tracker, 'b', 'failed');
    expect(sessionUsageSchema.parse(tracker.evidence().usage)).toMatchObject({
      coverage: 'partial', totals: { freshInput: 120, cacheRead: 80, output: 21, reasoningOutput: 7 }
    });
  });

  it('removes attribution retroactively for reroutes or child overlap without adding child counters', () => {
    const tracker = new CodexUsage('parent', key);
    tracker.ownTurn('a');
    update(tracker, 'a', [100, 60, 10], [100, 60, 10]);
    tracker.observe('model/rerouted', { threadId: 'parent', turnId: 'a', fromModel: 'served', toModel: 'other', reason: 'policy' });
    complete(tracker, 'a');
    expect(tracker.evidence().usage).toMatchObject({ coverage: 'complete', groups: [{ model: null }] });
    tracker.observe('item/completed', { threadId: 'parent', turnId: 'a', item: {
      type: 'collabAgentToolCall', senderThreadId: 'parent', receiverThreadIds: ['child']
    } });
    update(tracker, 'a', [1000, 80, 100], [1000, 80, 100], 'child');
    expect(tracker.evidence().usage).toMatchObject({
      coverage: 'partial', totals: { freshInput: 40, cacheRead: 60, output: 10 }, groups: [{ model: null }]
    });
  });

  it('does not close an invocation after a pricing counter loses its comparison baseline', () => {
    const tracker = new CodexUsage('parent', key);
    tracker.ownTurn('a');
    update(tracker, 'a', [100, 60, 10], [100, 60, 10]);
    update(tracker, 'a', [Number.NaN, 80, 20]);
    update(tracker, 'a', [200, 100, 30]);
    update(tracker, 'a', [230, 120, 40], [30, 20, 10]);
    complete(tracker, 'a', 'failed');
    expect(sessionUsageSchema.parse(tracker.evidence().usage)).toMatchObject({
      coverage: 'partial', totals: { freshInput: 50, cacheRead: 120, output: 40 }
    });
    expect(tracker.anomalies).toContain('invalid_counter');
  });
});
