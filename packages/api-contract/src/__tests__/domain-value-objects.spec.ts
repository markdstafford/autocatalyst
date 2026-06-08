import { describe, expect, it } from 'vitest';

import {
  channelReferenceSchema,
  costSchema,
  feedbackAnchorSchema,
  feedbackThreadSchema,
  inferenceSettingsSchema,
  modelIdentitySchema,
  sessionRoleSchema,
  testingGuideResultSchema,
  tokenBreakdownSchema,
  trackedIssueSchema
} from '../domain-value-objects.js';

const humanPrincipal = {
  id: 'user_1',
  kind: 'human',
  tenantId: 'tenant_1',
  displayName: 'Ada'
} as const;

const tokens = { input: 10, output: 20, cacheRead: 3, cacheWrite: 4 };

describe('domain value-object contracts', () => {
  it('validates token counts as strict non-negative integers', () => {
    expect(tokenBreakdownSchema.parse(tokens)).toEqual(tokens);
    expect(() => tokenBreakdownSchema.parse({ ...tokens, input: -1 })).toThrow();
    expect(() => tokenBreakdownSchema.parse({ ...tokens, output: 1.5 })).toThrow();
    expect(() => tokenBreakdownSchema.parse({ ...tokens, extra: 0 })).toThrow();
  });

  it('preserves known and unknown nano-dollar costs', () => {
    const known = { model: { provider: 'openai', model: 'gpt-4.1' }, usd: 1234, tokens };
    expect(costSchema.parse(known)).toEqual(known);
    expect(costSchema.parse({ ...known, usd: null }).usd).toBeNull();
    expect(costSchema.parse({ model: known.model, tokens })).not.toHaveProperty('usd');
    expect(() => costSchema.parse({ ...known, usd: 12.5 })).toThrow();
  });

  it('validates tracked issues, channels, model identity, and inference settings', () => {
    expect(modelIdentitySchema.parse({ provider: 'anthropic', model: 'claude', displayName: 'Claude' })).toEqual({
      provider: 'anthropic',
      model: 'claude',
      displayName: 'Claude'
    });
    expect(trackedIssueSchema.parse({ number: 12, title: 'Add persistence', state: 'open', url: 'https://example.test/issues/12' })).toEqual({
      number: 12,
      title: 'Add persistence',
      state: 'open',
      url: 'https://example.test/issues/12'
    });
    expect(channelReferenceSchema.parse({ provider: 'slack', channelId: 'C1', threadId: 'T1', url: 'https://example.test/thread' }).provider).toBe('slack');
    expect(inferenceSettingsSchema.parse({ temperature: 0.2, topP: 0.9, maxOutputTokens: 1024, reasoningEffort: 'high', seed: 42, extra: { providerOption: true } }).extra).toEqual({ providerOption: true });
  });

  it('validates feedback anchors and non-empty attributed threads', () => {
    expect(feedbackAnchorSchema.parse({ kind: 'artifact', artifactId: 'art_1' })).toEqual({ kind: 'artifact', artifactId: 'art_1' });
    expect(feedbackAnchorSchema.parse({ kind: 'file_range', path: 'src/index.ts', startLine: 1, endLine: 3 }).endLine).toBe(3);
    expect(() => feedbackAnchorSchema.parse({ kind: 'file_range', path: 'src/index.ts', startLine: 3, endLine: 1 })).toThrow();
    expect(feedbackThreadSchema.parse([{ id: 'thread_1', author: humanPrincipal, body: 'Please clarify.', createdAt: '2026-06-08T00:00:00.000Z' }])).toHaveLength(1);
    expect(() => feedbackThreadSchema.parse([])).toThrow();
  });

  it('keeps session roles extensible while requiring lower snake case', () => {
    expect(sessionRoleSchema.parse('implementer')).toBe('implementer');
    expect(sessionRoleSchema.parse('future_mediator')).toBe('future_mediator');
    expect(() => sessionRoleSchema.parse('FutureMediator')).toThrow();
  });

  it('validates testing-guide results and evidence shapes', () => {
    expect(testingGuideResultSchema.parse({ status: 'not_run' })).toEqual({ status: 'not_run' });
    expect(testingGuideResultSchema.parse({
      status: 'failed',
      summary: 'Manual pass found a blocker.',
      checkedAt: '2026-06-08T00:00:00.000Z',
      evidence: [{ kind: 'external', url: 'https://example.test/report' }]
    }).status).toBe('failed');
  });
});
