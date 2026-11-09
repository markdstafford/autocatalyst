/**
 * Comment-column geometry: measured heights produce non-overlapping tops, including tall cards and
 * anchors near the bottom of the spec, plus correctly-ordered stale / no-range groups.
 */
import { describe, expect, it } from 'vitest';

import { layoutCommentColumn, type AnchoredCardLayoutInput } from './comment-layout.js';

const GAP = 8;
const GROUP_GAP = 24;

function layout(anchored: AnchoredCardLayoutInput[], staleHeight = 0, noRangeHeight = 0) {
  return layoutCommentColumn({ anchored, staleHeight, noRangeHeight, gap: GAP, groupGap: GROUP_GAP });
}

describe('layoutCommentColumn', () => {
  it('places a single card at its anchor top', () => {
    const result = layout([{ id: 'a', anchorTop: 120, height: 60 }]);
    expect(result.tops.get('a')).toBe(120);
    expect(result.height).toBe(180);
  });

  it('pushes a later card down so tall cards never overlap', () => {
    // Two anchors only 30px apart, but the first card is 90px tall: the second must be pushed below it.
    const result = layout([
      { id: 'a', anchorTop: 0, height: 90 },
      { id: 'b', anchorTop: 30, height: 40 }
    ]);
    expect(result.tops.get('a')).toBe(0);
    // b cannot sit at 30 (would overlap a, which ends at 90); it is pushed to 90 + gap.
    expect(result.tops.get('b')).toBe(90 + GAP);
    expect(result.height).toBe(90 + GAP + 40);
  });

  it('keeps every card non-overlapping and reachable when anchors run past the document end', () => {
    // A cross-block comment with its anchor near the very bottom, and a short last card whose anchor is
    // beyond the previous card's bottom — the column height must contain all of them.
    const cards: AnchoredCardLayoutInput[] = [
      { id: 'a', anchorTop: 10, height: 50 },
      { id: 'b', anchorTop: 55, height: 120 }, // tall multi-line card overlapping a's region
      { id: 'c', anchorTop: 900, height: 40 } // anchor near the end of a long spec
    ];
    const result = layout(cards);
    const tops = cards.map((card) => ({ id: card.id, top: result.tops.get(card.id)!, height: card.height }));
    // No card overlaps the previous one.
    for (let i = 1; i < tops.length; i += 1) {
      expect(tops[i]!.top).toBeGreaterThanOrEqual(tops[i - 1]!.top + tops[i - 1]!.height);
    }
    // c keeps its own far-down anchor (there is room there).
    expect(result.tops.get('c')).toBe(900);
    // The column grows to contain the last card.
    expect(result.height).toBe(900 + 40);
  });

  it('orders stale then no-range groups after the anchored cards with a group gap', () => {
    const result = layout([{ id: 'a', anchorTop: 0, height: 50 }], 70, 40);
    // stale starts a group-gap below the last anchored card bottom (50) + gap already consumed.
    expect(result.staleTop).toBe(50 + GROUP_GAP);
    expect(result.noRangeTop).toBe(50 + GROUP_GAP + 70 + GROUP_GAP);
    expect(result.height).toBe(50 + GROUP_GAP + 70 + GROUP_GAP + 40);
  });

  it('positions a stale group from measured height even with no anchored cards', () => {
    const result = layout([], 70, 0);
    expect(result.staleTop).toBe(0);
    expect(result.height).toBe(70);
  });

  it('falls back to the cursor when an anchor top is unknown', () => {
    const result = layout([
      { id: 'a', anchorTop: null, height: 30 },
      { id: 'b', anchorTop: null, height: 30 }
    ]);
    expect(result.tops.get('a')).toBe(0);
    expect(result.tops.get('b')).toBe(30 + GAP);
  });
});
