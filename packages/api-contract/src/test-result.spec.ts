import { describe, expect, it } from 'vitest';

import { saveTestingGuideResultsRequestSchema, testResultSchema, TEST_RESULT_NOTE_MAX_LENGTH } from './test-result.js';

describe('testing guide results contracts', () => {
  it('defaults legacy results without replacing their outcome, evidence or refs', () => {
    const legacy = {
      id: 'test_1', runId: 'run_1', tester: { id: 'enzo', kind: 'human', tenantId: 'tenant', displayName: 'Enzo' },
      outcome: 'blocked', evidence: { kind: 'external', url: 'https://example.test/evidence' }, feedbackRefs: ['fb_1'],
      createdAt: '2026-11-28T00:00:00Z', updatedAt: '2026-11-28T00:00:00Z'
    };
    expect(testResultSchema.parse(legacy)).toEqual({ ...legacy, state: 'final', items: [] });
  });

  it('accepts explicit clearing, blank and max-length notes, and empty patches', () => {
    expect(saveTestingGuideResultsRequestSchema.parse({ guideRevision: 1, items: [] }).items).toEqual([]);
    for (const note of [null, '', 'x'.repeat(TEST_RESULT_NOTE_MAX_LENGTH)]) {
      const input = { guideRevision: 1, items: [{ id: 'a', outcome: null, note }] };
      expect(saveTestingGuideResultsRequestSchema.parse(input)).toEqual(input);
    }
  });

  it.each([
    { items: [{ id: 'a', outcome: 'passed', note: null }, { id: 'a', outcome: null, note: 'duplicate' }] },
    { items: [{ id: 'a', outcome: 'blocked', note: '' }] },
    { items: [{ id: '', outcome: 'passed', note: '' }] },
    { items: [{ id: 'a', outcome: 'passed' }] },
    { items: [{ id: 'a', outcome: 'passed', note: 'x'.repeat(TEST_RESULT_NOTE_MAX_LENGTH + 1) }] },
    { items: [{ id: 'a', outcome: 'passed', note: null, feedbackId: 'fb_1' }] },
    { items: [], tester: 'enzo' },
    { items: [], guideRevision: 0 }
  ])('rejects invalid or server-owned fields: %#', input => {
    expect(saveTestingGuideResultsRequestSchema.safeParse({ guideRevision: 1, ...input }).success).toBe(false);
  });
});
