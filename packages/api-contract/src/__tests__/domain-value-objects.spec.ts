import { describe, expect, it } from 'vitest';

import {
  channelReferenceSchema,
  costSchema,
  credentialReferenceSchema,
  feedbackAnchorSchema,
  feedbackThreadEntrySchema,
  feedbackThreadSchema,
  frontedResourceSchema,
  inferenceSettingsSchema,
  jsonValueSchema,
  modelIdentitySchema,
  nonModelPrincipalSchema,
  sessionRoleSchema,
  testResultEvidenceSchema,
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
    expect(sessionRoleSchema.parse('none')).toBe('none');
    expect(() => sessionRoleSchema.parse('FutureMediator')).toThrow();
  });

  it('nonModelPrincipalSchema accepts human and system but rejects model', () => {
    const base = { id: 'p_1', tenantId: 'tenant_1' };
    expect(nonModelPrincipalSchema.parse({ ...base, kind: 'human' }).kind).toBe('human');
    expect(nonModelPrincipalSchema.parse({ ...base, kind: 'system' }).kind).toBe('system');
    expect(() => nonModelPrincipalSchema.parse({ ...base, kind: 'model' })).toThrow();
  });

  it('jsonValueSchema accepts primitives, arrays, and nested records', () => {
    expect(jsonValueSchema.parse('hello')).toBe('hello');
    expect(jsonValueSchema.parse(42)).toBe(42);
    expect(jsonValueSchema.parse(true)).toBe(true);
    expect(jsonValueSchema.parse(null)).toBeNull();
    expect(jsonValueSchema.parse([1, 'two', null])).toEqual([1, 'two', null]);
    expect(jsonValueSchema.parse({ a: { b: [false, 0] } })).toEqual({ a: { b: [false, 0] } });
  });

  it('credentialReferenceSchema validates purpose enum and rejects invalid purposes', () => {
    expect(credentialReferenceSchema.parse({ id: 'cred_1', purpose: 'repo' })).toEqual({ id: 'cred_1', purpose: 'repo' });
    expect(credentialReferenceSchema.parse({ id: 'cred_2', purpose: 'other', label: 'My Token' }).label).toBe('My Token');
    expect(() => credentialReferenceSchema.parse({ id: 'cred_3', purpose: 'unknown_purpose' })).toThrow();
  });

  it('feedbackThreadEntrySchema validates a single thread entry directly', () => {
    const entry = { id: 'entry_1', author: humanPrincipal, body: 'LGTM.', createdAt: '2026-06-08T00:00:00.000Z' };
    expect(feedbackThreadEntrySchema.parse(entry)).toEqual(entry);
    expect(() => feedbackThreadEntrySchema.parse({ ...entry, body: '' })).toThrow();
    expect(() => feedbackThreadEntrySchema.parse({ ...entry, createdAt: 'not-a-date' })).toThrow();
  });

  it('testResultEvidenceSchema validates each evidence kind', () => {
    expect(testResultEvidenceSchema.parse({ kind: 'artifact', id: 'art_1' })).toEqual({ kind: 'artifact', id: 'art_1' });
    expect(() => testResultEvidenceSchema.parse({ kind: 'artifact' })).toThrow();
    expect(testResultEvidenceSchema.parse({ kind: 'log', url: 'https://example.test/log' })).toEqual({ kind: 'log', url: 'https://example.test/log' });
    expect(testResultEvidenceSchema.parse({ kind: 'log', summary: 'All green' })).toEqual({ kind: 'log', summary: 'All green' });
    expect(() => testResultEvidenceSchema.parse({ kind: 'log' })).toThrow();
    expect(testResultEvidenceSchema.parse({ kind: 'external', url: 'https://example.test/report' })).toEqual({ kind: 'external', url: 'https://example.test/report' });
    expect(testResultEvidenceSchema.parse({ kind: 'external', summary: 'See CI' })).toEqual({ kind: 'external', summary: 'See CI' });
    expect(() => testResultEvidenceSchema.parse({ kind: 'external' })).toThrow();
  });

  it('frontedResourceSchema validates artifact (requires id), issue, and external (require reference or url)', () => {
    expect(frontedResourceSchema.parse({ kind: 'artifact', id: 'art_1' })).toEqual({ kind: 'artifact', id: 'art_1' });
    expect(() => frontedResourceSchema.parse({ kind: 'artifact' })).toThrow();
    expect(frontedResourceSchema.parse({ kind: 'issue', reference: 'PROJ-42' })).toEqual({ kind: 'issue', reference: 'PROJ-42' });
    expect(frontedResourceSchema.parse({ kind: 'issue', url: 'https://example.test/issues/1' })).toEqual({ kind: 'issue', url: 'https://example.test/issues/1' });
    expect(() => frontedResourceSchema.parse({ kind: 'issue' })).toThrow();
    expect(frontedResourceSchema.parse({ kind: 'external', reference: 'ext-ref' })).toEqual({ kind: 'external', reference: 'ext-ref' });
    expect(frontedResourceSchema.parse({ kind: 'external', url: 'https://example.test/ext' })).toEqual({ kind: 'external', url: 'https://example.test/ext' });
    expect(() => frontedResourceSchema.parse({ kind: 'external' })).toThrow();
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
