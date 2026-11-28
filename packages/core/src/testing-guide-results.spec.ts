import { describe, expect, it } from 'vitest';
import { testResultSchema, type TestResultItem, type TestingGuide } from '@autocatalyst/api-contract';

import { buildImplementationBuildPrompt } from './implementation-build-context.js';
import { deriveTestResultOutcome, failedTestingItemFeedbackBody, patchTestingGuideItems, seedTestingGuidePass, testingNotesForPass } from './testing-guide-results.js';

const now = '2026-11-28T00:00:00Z';
const tester = { id: 'enzo', kind: 'human', tenantId: 'tenant', displayName: 'Enzo' } as const;
const guide = (ids: string[]): TestingGuide => ({
  id: 'guide', revision: 1, runId: 'run', instructions: 'Test the build',
  createdAt: now, items: ids.map(id => ({ id, text: `Check ${id}` }))
});
const previous: TestResultItem[] = [
  { id: 'A', outcome: 'passed', note: 'Fast.', feedbackId: 'old_link' },
  { id: 'B', note: 'For later.' },
  { id: 'C', outcome: 'failed', note: 'Wrong case.', feedbackId: 'failure' },
  { id: 'D', outcome: 'passed', note: 'Original D worked.' }
];

describe('testing guide pass rules', () => {
  it('derives the outcome from marks only, with failure taking precedence', () => {
    expect(deriveTestResultOutcome([])).toBe('inconclusive');
    expect(deriveTestResultOutcome([{ id: 'A', note: 'No mark' }])).toBe('inconclusive');
    expect(deriveTestResultOutcome(previous.slice(0, 2))).toBe('passed');
    expect(deriveTestResultOutcome(previous)).toBe('failed');
  });

  it('carries stable IDs in guide order and clears failed, rewritten, new, and removed checks', () => {
    expect(seedTestingGuidePass({ ...guide(['C', 'A', 'D2', 'E', 'B']), revision: 2 }, { items: previous })).toEqual([
      { id: 'C' }, { id: 'A', outcome: 'passed', note: 'Fast.' }, { id: 'D2' }, { id: 'E' }, { id: 'B', note: 'For later.' }
    ]);
    expect(seedTestingGuidePass(guide(['A', 'B', 'C', 'D']), { items: previous })).toEqual([
      { id: 'A', outcome: 'passed', note: 'Fast.' }, { id: 'B', note: 'For later.' },
      { id: 'C' }, { id: 'D', outcome: 'passed', note: 'Original D worked.' }
    ]);
  });

  it('patches only the named items and unsets nulls independently', () => {
    expect(patchTestingGuideItems(previous, [
      { id: 'B', outcome: 'passed', note: null }, { id: 'D', outcome: null, note: '' }
    ])).toEqual([previous[0], { id: 'B', outcome: 'passed' }, previous[2], { id: 'D', note: '' }]);
  });

  it('uses the nonblank failure note verbatim or falls back to the guide item', () => {
    const item = { id: 'A', text: 'Try the build' };
    expect(failedTestingItemFeedbackBody(item)).toBe(item.text);
    const withExpected = { ...item, expected: 'Build completes.' };
    expect(failedTestingItemFeedbackBody(withExpected, '  ')).toBe('Try the build\n\nExpected: Build completes.');
    expect(failedTestingItemFeedbackBody(withExpected, ' Wrong case. ')).toBe(' Wrong case. ');
  });

  it('renders unlinked non-failure notes only to the implementer in recorded guide order', () => {
    const result = testResultSchema.parse({
      id: 'test', runId: 'run', outcome: 'failed', tester, items: previous, guideRevision: 1,
      feedbackRefs: [], createdAt: now, updatedAt: now
    });
    const notes = testingNotesForPass({ guide: guide(['D', 'A', 'C', 'B']), result });
    expect(notes).toEqual([
      { text: 'Check D', outcome: 'passed', note: 'Original D worked.' },
      { text: 'Check B', outcome: 'unanswered', note: 'For later.' }
    ]);
    const run = {
      id: 'run', topicId: 'topic', owner: tester, tenant: 'tenant', workKind: 'chore',
      currentStep: 'implementation.build', terminal: false, createdAt: now, updatedAt: now
    };
    const input = { run, round: 1, testingNotes: notes };
    const prompt = buildImplementationBuildPrompt({ ...input, role: 'implementer' });
    expect(prompt).toContain('## Testing notes');
    expect(prompt).toContain('require no disposition');
    expect(prompt).toContain('"Check D" (passed): "Original D worked."');
    expect(prompt).toContain('"Check B" (unanswered): "For later."');
    expect(prompt).not.toContain('Wrong case.');
    expect(buildImplementationBuildPrompt({ ...input, role: 'reviewer' })).not.toContain('Testing notes');
    expect(buildImplementationBuildPrompt({ ...input, testingNotes: [], role: 'implementer' })).not.toContain('Testing notes');
  });
});
