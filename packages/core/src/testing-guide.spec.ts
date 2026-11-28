import { describe, expect, it, vi } from 'vitest';
import { TESTING_GUIDE_DIFF_MAX_BYTES, testingGuideAuthorResultSchema } from '@autocatalyst/api-contract';
import { assignTestingGuideItemIds, authorTestingGuide, buildTestingGuidePrompt, truncateTestingGuideDiff } from './testing-guide.js';

const valid = { instructions: 'Inspect the build.', items: [{ text: 'Inspect it.' }] };

describe('testing guide author contract and matching', () => {
  it('enforces field and list boundaries and a strict result shape', () => {
    const parse = (input: unknown) => testingGuideAuthorResultSchema.safeParse(input).success;
    expect(parse({ instructions: 'x'.repeat(20_000), items: Array.from({ length: 30 }, (_, i) =>
      ({ text: i.toString().padEnd(500, 'x'), expected: 'e'.repeat(1_000) })) })).toBe(true);
    expect(parse(valid)).toBe(true);
    for (const input of [
      { ...valid, instructions: '' }, { ...valid, instructions: 'x'.repeat(20_001) },
      { ...valid, items: [] }, { ...valid, items: Array.from({ length: 31 }, (_, i) => ({ text: String(i) })) },
      { ...valid, items: [{ text: '' }] }, { ...valid, items: [{ text: 'x'.repeat(501) }] },
      { ...valid, items: [{ text: 'x', expected: 'e'.repeat(1001) }] },
      { ...valid, items: [{ text: 'x', expected: null }] }, { ...valid, items: [{ ...valid.items[0], id: 'model-id' }] },
      { ...valid, extra: true },
      { ...valid, items: [{ text: 'É  A', expected: 'yes' }, { text: ' E\u0301 A ', expected: ' yes ' }] }
    ]) expect(parse(input)).toBe(false);
    expect(parse({ ...valid, items: [{ text: 'same' }, { text: 'same', expected: '' }, { text: 'Same' }] })).toBe(true);
  });

  it('preserves IDs only for equivalent wording in the immediately previous guide', () => {
    const first = assignTestingGuideItemIds([], [
      { text: 'É  A', expected: 'yes' }, { text: 'B' }, { text: 'C', expected: '' }, { text: 'D' }, { text: 'E' }
    ]);
    expect(new Set(first.map(item => item.id)).size).toBe(5);
    const second = assignTestingGuideItemIds(first, [
      { text: 'D' }, { text: ' E\u0301\tA ', expected: ' yes ' }, { text: 'B', expected: 'changed' },
      { text: 'C' }, { text: 'e' }
    ]);
    expect(second.slice(0, 2).map(item => item.id)).toEqual([first[3]?.id, first[0]?.id]);
    expect(second[1]?.text).toBe(' E\u0301\tA ');
    expect(second.slice(2).every(item => !first.some(old => old.id === item.id))).toBe(true);
    const third = assignTestingGuideItemIds(second, [{ text: 'B' }]);
    expect(third[0]?.id).not.toBe(first[1]?.id);
  });

  it('returns the longest complete UTF-8 lines and retains the file list', () => {
    const line = 'é'.repeat(99_999) + '\n';
    expect(Buffer.byteLength(line)).toBe(TESTING_GUIDE_DIFF_MAX_BYTES - 1);
    const prefix = truncateTestingGuideDiff(line + 'é\n');
    expect(prefix).toEqual({ text: line, truncated: true });
    expect(truncateTestingGuideDiff('é'.repeat(100_001) + '\n')).toEqual({ text: '', truncated: true });
    expect(truncateTestingGuideDiff('abc')).toEqual({ text: 'abc', truncated: false });
    const oversized = buildTestingGuidePrompt({ changedFiles: ['first', 'last'], diff: 'é'.repeat(100_001) + '\n' });
    expect(oversized).toContain('Diff truncated');
    expect(oversized).toContain('Changed files: ["first","last"]');
    expect(oversized).not.toContain('Final diff (evidence)');
    expect(buildTestingGuidePrompt({ changedFiles: [], diff: '' })).toContain('Final diff: empty');
    expect(buildTestingGuidePrompt({ changedFiles: [], diff: null })).toContain('Final diff: unavailable');
  });

  it('uses bounded output correction and does not retry provider failures as corrections', async () => {
    const runId = 'run_1';
    const request = vi.fn().mockResolvedValueOnce({ directive: 'fail', reason: 'structured_result_invalid' })
      .mockResolvedValueOnce({ directive: 'advance', result: valid });
    expect(await authorTestingGuide({ runId, request })).toEqual({ guide: valid });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[0]).toMatch(/Correction 1\/2/);
    request.mockReset().mockResolvedValue({ directive: 'advance', result: { ...valid, extra: true } });
    expect(await authorTestingGuide({ runId, request })).toEqual({ reason: 'testing_guide_failed' });
    expect(request).toHaveBeenCalledTimes(3);
    request.mockReset().mockResolvedValueOnce({ directive: 'advance', result: {} })
      .mockResolvedValueOnce({ directive: 'fail', reason: 'provider_auth_failed' });
    expect(await authorTestingGuide({ runId, request })).toEqual({ reason: 'provider_auth_failed' });
    expect(request).toHaveBeenCalledTimes(2);
  });
});
