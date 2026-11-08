import type { FeedbackAnchor } from '@autocatalyst/api-contract';

/**
 * Spec feedback anchor validation (ADR-033).
 *
 * A spec anchor is an `artifact_range` anchor for the current spec artifact, carrying `from`/`to`
 * code-point offsets and the `quotedText` those offsets must reproduce. The control plane validates
 * present spec anchors on write (feedback creation and spec-gate feedback replies) before any item
 * or directive is produced. Offsets are counted in Unicode code points — `Array.from(markdown)` —
 * never UTF-16 code units, because quotes can begin after astral characters (emoji).
 */

export type SpecAnchorInvalidReason =
  | 'wrong_kind'
  | 'wrong_artifact'
  | 'out_of_range'
  | 'missing_quoted_text'
  | 'text_mismatch';

export class SpecAnchorValidationError extends Error {
  readonly code = 'invalid_feedback_anchor' as const;
  readonly reason: SpecAnchorInvalidReason;

  constructor(reason: SpecAnchorInvalidReason, message: string) {
    super(message);
    this.name = 'SpecAnchorValidationError';
    this.reason = reason;
  }
}

export interface CurrentSpecForAnchor {
  /** The id of the current spec artifact; a valid anchor's `artifactId` must equal this. */
  readonly artifactId: string;
  /** The current spec markdown source the offsets index into. */
  readonly markdown: string;
}

/**
 * Validate a present spec feedback anchor against the current spec. Throws
 * {@link SpecAnchorValidationError} with a typed reason on failure; returns normally on success.
 *
 * Callers invoke this only when an anchor is present on spec/artifact feedback. Absent anchors are
 * accepted without reading the spec and must not reach this function.
 */
export function validateSpecAnchor(input: {
  readonly anchor: FeedbackAnchor;
  readonly currentSpec: CurrentSpecForAnchor;
}): void {
  const { anchor, currentSpec } = input;

  // 4. Must be an artifact_range anchor.
  if (anchor.kind !== 'artifact_range') {
    throw new SpecAnchorValidationError('wrong_kind', 'Spec anchors must be artifact_range anchors.');
  }

  // 5. Must target the current spec artifact.
  if (anchor.artifactId !== currentSpec.artifactId) {
    throw new SpecAnchorValidationError('wrong_artifact', 'Spec anchor does not target the current spec artifact.');
  }

  // 6. quotedText is required for a validated spec anchor (the stored schema keeps it optional for
  // legacy rows, so the server enforces presence here rather than at schema parse time).
  if (typeof anchor.quotedText !== 'string' || anchor.quotedText.length === 0) {
    throw new SpecAnchorValidationError('missing_quoted_text', 'Spec anchor must include quotedText.');
  }

  // 7. Code-point bounds: 0 <= from < to <= n.
  const codePoints = Array.from(currentSpec.markdown);
  const n = codePoints.length;
  if (!(anchor.from >= 0 && anchor.from < anchor.to && anchor.to <= n)) {
    throw new SpecAnchorValidationError('out_of_range', 'Spec anchor offsets are out of range for the current spec.');
  }

  // 8. The slice at [from, to) must reproduce quotedText exactly.
  const slice = codePoints.slice(anchor.from, anchor.to).join('');
  if (slice !== anchor.quotedText) {
    throw new SpecAnchorValidationError('text_mismatch', 'Spec anchor offsets do not reproduce quotedText.');
  }

  // 9. Accept.
}
