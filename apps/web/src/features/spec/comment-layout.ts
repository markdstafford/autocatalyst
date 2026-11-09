/**
 * Pure comment-column geometry.
 *
 * The comment column stacks anchored cards beside the text they annotate, then the stale and
 * no-range groups below them. Card heights are not knowable ahead of render — a multi-line comment is
 * taller than a one-liner — so the Spec tab measures each rendered card and feeds the measured heights
 * here. This module turns (anchor tops + measured heights) into non-overlapping `top` positions and a
 * total column height, with no DOM access, so the overlap rules are unit-testable without a browser.
 *
 * Rules:
 * - Anchored cards keep document order. Each sits at its anchor's top when there is room, otherwise it
 *   is pushed down below the previous card so cards never overlap — including when an anchor is near
 *   the bottom of the spec or several tall cards collide.
 * - The stale group (if any) follows the anchored cards, then the no-range group (if any), each as one
 *   measured block.
 * - `height` is the bottom of the last placed element, so the column can grow (via `min-height`) to
 *   contain every card even when the last anchor is far down the document.
 */

export interface AnchoredCardLayoutInput {
  readonly id: string;
  /** Top of this card's marker, in comment-column coordinates, or null when geometry is unknown. */
  readonly anchorTop: number | null;
  /** Measured rendered height of the card. */
  readonly height: number;
}

export interface CommentColumnLayoutInput {
  readonly anchored: readonly AnchoredCardLayoutInput[];
  /** Measured height of the whole stale `<section>` (heading + cards); 0 when there is no stale group. */
  readonly staleHeight: number;
  /** Measured height of the whole no-range `<section>`; 0 when there is no no-range group. */
  readonly noRangeHeight: number;
  /** Vertical gap between adjacent anchored cards. */
  readonly gap: number;
  /** Larger gap before an end-of-column group. */
  readonly groupGap: number;
}

export interface CommentColumnLayout {
  /** Absolute top for each anchored card, keyed by id. */
  readonly tops: Map<string, number>;
  /** Absolute top for the stale group section (meaningful only when staleHeight > 0). */
  readonly staleTop: number;
  /** Absolute top for the no-range group section (meaningful only when noRangeHeight > 0). */
  readonly noRangeTop: number;
  /** Bottom edge of the last placed element: the column's required height. */
  readonly height: number;
}

/** Lay out the comment column from measured heights and marker tops. */
export function layoutCommentColumn(input: CommentColumnLayoutInput): CommentColumnLayout {
  const { anchored, staleHeight, noRangeHeight, gap, groupGap } = input;
  const tops = new Map<string, number>();

  // `cursor` is the first free vertical position (top) for the next element.
  let cursor = 0;
  let bottom = 0;
  let placedAny = false;

  for (const card of anchored) {
    const desired = card.anchorTop ?? cursor;
    const top = Math.max(desired, cursor);
    tops.set(card.id, top);
    bottom = top + card.height;
    cursor = bottom + gap;
    placedAny = true;
  }

  let staleTop = cursor;
  if (staleHeight > 0) {
    staleTop = placedAny ? cursor + (groupGap - gap) : cursor;
    bottom = staleTop + staleHeight;
    cursor = bottom + gap;
    placedAny = true;
  }

  let noRangeTop = cursor;
  if (noRangeHeight > 0) {
    noRangeTop = placedAny ? cursor + (groupGap - gap) : cursor;
    bottom = noRangeTop + noRangeHeight;
    cursor = bottom + gap;
    placedAny = true;
  }

  return { tops, staleTop, noRangeTop, height: placedAny ? bottom : 0 };
}
