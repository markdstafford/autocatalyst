import { describe, expect, it } from 'vitest';
import { boundedEvidence, renderCiDiagnostics, renderReviewedHandoff, type HandoffEvidence } from './reviewed-handoff.js';

describe('reviewed handoff', () => {
  it('excludes required evidence before budgeting, keeping separately identified evidence', () => {
    const common = { current: true, order: 2, feedbackId: 'f' };
    const evidence: HandoffEvidence[] = [
      { ...common, id: 'f', kind: 'finding', text: 'duplicated '.repeat(1000) },
      { ...common, id: 'd1', kind: 'disposition', text: 'duplicated '.repeat(1000) },
      { ...common, id: 'd2', kind: 'disposition', text: 'observed on newer revision' },
      { ...common, id: 'path', kind: 'revision', text: 'lower priority evidence' }
    ];
    const input = { requiredFindingIds: new Set(['f']), requiredDispositions: new Set(['["f","d1"]']) };
    const rendered = renderReviewedHandoff({ ...input, evidence });
    expect(rendered).toContain('observed on newer revision');
    expect(rendered).toContain('lower priority evidence');
    expect(rendered).not.toContain('duplicated');
    expect(rendered).not.toContain('[truncated]');
    expect(renderReviewedHandoff({ ...input, evidence: evidence.reverse() })).toBe(rendered);
  });

  it('accounts for headings and markers without cutting a multibyte character', () => {
    expect(boundedEvidence('H', ['a🐈'], 7)).toBe('H\na🐈');
    const out = boundedEvidence('H', ['🐈'.repeat(100)], 24);
    expect(out).toBe('H\n🐈🐈\n[truncated]');
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(24);
    expect(Buffer.byteLength(renderReviewedHandoff({
      evidence: [{ id: 'x', kind: 'finding', current: true, order: 0, text: 'a'.repeat(10_000) }]
    }))).toBe(8192);
  });

  it('prioritizes CI summaries, sorts check identities, and caps CI independently', () => {
    const text = renderCiDiagnostics([
      { id: 'two', name: 'B', summary: 'second', excerpts: [{ sequence: 3, text: 'log '.repeat(2000) }] },
      { id: 'one', name: 'A', summary: 'first token=not-for-prompt', excerpts: [
        { sequence: 1, text: 'old' }, { sequence: 2, text: 'newer' }
      ] }
    ]);
    expect(text).toMatch(/A \(one\): first token=\[redacted\][\s\S]*B \(two\): second[\s\S]*newer[\s\S]*old/u);
    expect(text).not.toContain('not-for-prompt');
    expect(text.endsWith('[truncated]')).toBe(true);
    expect(Buffer.byteLength(text)).toBe(4096);
  });
});
