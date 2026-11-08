/**
 * Classify spec feedback into the three comment-column groups.
 *
 * The web client trusts the control plane's reconciled offsets and stale flags (ADR-033): it never
 * searches for moved quotes or compares quote text. It only:
 * - keeps `target: 'artifact'` feedback for this tab,
 * - renders an `artifact_range` anchor without `stale` at its returned offsets (anchored),
 * - shows `stale: true` anchors, and anchors still out of bounds after one reread, in the stale
 *   group, and
 * - shows missing or non-`artifact_range` anchors in the no-range group.
 *
 * Out-of-bounds detection is exposed separately ({@link hasOutOfBoundsArtifactAnchors}) so the Spec
 * tab can trigger exactly one spec+feedback reread before folding any still-invalid anchors into the
 * stale group.
 */
import type { FeedbackResponse, FeedbackStatus, FeedbackThreadEntry } from '@autocatalyst/api-contract';

export interface SpecCommentBase {
  readonly id: string;
  readonly status: FeedbackStatus;
  readonly authorId: string;
  readonly authorName: string;
  readonly createdAt: string;
  readonly title: string;
  readonly body: string;
  /** Thread entries after the first (the first entry mirrors the original body). */
  readonly replies: readonly FeedbackThreadEntry[];
}

export interface AnchoredComment extends SpecCommentBase {
  readonly kind: 'anchored';
  readonly from: number;
  readonly to: number;
  readonly quotedText: string | undefined;
}

export interface StaleComment extends SpecCommentBase {
  readonly kind: 'stale';
  readonly quotedText: string | undefined;
}

export interface NoRangeComment extends SpecCommentBase {
  readonly kind: 'no-range';
  readonly quotedText: string | undefined;
}

export type SpecComment = AnchoredComment | StaleComment | NoRangeComment;

export interface ClassifiedComments {
  readonly anchored: readonly AnchoredComment[];
  readonly stale: readonly StaleComment[];
  readonly noRange: readonly NoRangeComment[];
}

/** Marker visual family: open comments draw the open style; everything else draws resolved. */
export function markerStyleForStatus(status: FeedbackStatus): 'open' | 'resolved' {
  return status === 'open' ? 'open' : 'resolved';
}

function base(item: FeedbackResponse): SpecCommentBase {
  return {
    id: item.id,
    status: item.status,
    authorId: item.owner.id,
    authorName: item.owner.displayName ?? item.owner.id,
    createdAt: item.createdAt,
    title: item.title,
    body: item.body,
    replies: item.thread.slice(1)
  };
}

function isArtifactRangeInBounds(
  anchor: NonNullable<FeedbackResponse['anchor']>,
  markdownCodePointLength: number
): boolean {
  if (anchor.kind !== 'artifact_range') {
    return false;
  }
  return anchor.from >= 0 && anchor.to <= markdownCodePointLength && anchor.from < anchor.to;
}

/** Classify artifact feedback into anchored / stale / no-range groups. */
export function classifySpecFeedback(
  feedback: readonly FeedbackResponse[],
  markdownCodePointLength: number
): ClassifiedComments {
  const anchored: AnchoredComment[] = [];
  const stale: StaleComment[] = [];
  const noRange: NoRangeComment[] = [];

  for (const item of feedback) {
    if (item.target !== 'artifact') {
      continue;
    }
    const anchor = item.anchor;
    if (anchor === undefined || anchor.kind !== 'artifact_range') {
      noRange.push({ ...base(item), kind: 'no-range', quotedText: anchor?.kind === 'artifact_range' ? anchor.quotedText : undefined });
      continue;
    }
    if (anchor.stale === true || !isArtifactRangeInBounds(anchor, markdownCodePointLength)) {
      stale.push({ ...base(item), kind: 'stale', quotedText: anchor.quotedText });
      continue;
    }
    anchored.push({
      ...base(item),
      kind: 'anchored',
      from: anchor.from,
      to: anchor.to,
      quotedText: anchor.quotedText
    });
  }

  // Anchored cards are shown in document order.
  anchored.sort((a, b) => a.from - b.from || a.to - b.to);
  return { anchored, stale, noRange };
}

/**
 * True when some artifact_range anchor (not already flagged stale) falls outside the current
 * markdown. The Spec tab uses this to decide whether to reread spec+feedback once before treating
 * the anchor as stale.
 */
export function hasOutOfBoundsArtifactAnchors(
  feedback: readonly FeedbackResponse[],
  markdownCodePointLength: number
): boolean {
  return feedback.some((item) => {
    if (item.target !== 'artifact') {
      return false;
    }
    const anchor = item.anchor;
    if (anchor === undefined || anchor.kind !== 'artifact_range' || anchor.stale === true) {
      return false;
    }
    return !isArtifactRangeInBounds(anchor, markdownCodePointLength);
  });
}
