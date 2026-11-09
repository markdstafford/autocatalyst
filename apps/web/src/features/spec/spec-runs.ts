/**
 * The source-range contract carried on rendered DOM.
 *
 * The renderer wraps every selectable text run in an element carrying these data attributes, and
 * the selection mapper reads them back to turn a DOM Range into source Markdown offsets. Keeping
 * the attribute names in one module stops the two sides drifting.
 *
 * A **run** is a leaf wrapper whose source range is `[start, end)` in Unicode **code-point**
 * offsets into the spec markdown:
 *
 * - `identity` — the run's concatenated DOM text equals `sliceByCodePoints(markdown, start, end)`
 *   exactly, so a caret offset inside it maps one-to-one to a source offset. This holds even
 *   after Shiki splits a code line into many colored spans, because the concatenation is
 *   unchanged. Soft line breaks live inside identity runs: the mdast text value preserves the
 *   `\n` / `\r\n`, so a selection across or just after a break maps to the right source newline
 *   with no special case.
 * - `opaque` — the rendered content does not map one-to-one to the source (entities, escapes,
 *   inline code with its backticks hidden, raw HTML shown as text). A selection boundary inside
 *   an opaque run snaps outward to the run's start (for the from side) or end (for the to side),
 *   so the quoted source always contains the selected rendered characters.
 */
export const SR_START_ATTR = 'data-sr-start';
export const SR_END_ATTR = 'data-sr-end';
export const SR_KIND_ATTR = 'data-sr-kind';

/** Marks the single element that is the rendered spec document root (the selectable region). */
export const SPEC_DOCUMENT_ATTR = 'data-spec-document';

export type SourceRunKind = 'identity' | 'opaque';

/** Read the code-point source range off a run element, or null if the attributes are absent. */
export function readRunRange(element: Element): { start: number; end: number; kind: SourceRunKind } | null {
  const startRaw = element.getAttribute(SR_START_ATTR);
  const endRaw = element.getAttribute(SR_END_ATTR);
  if (startRaw === null || endRaw === null) {
    return null;
  }
  const start = Number.parseInt(startRaw, 10);
  const end = Number.parseInt(endRaw, 10);
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return null;
  }
  const kind: SourceRunKind = element.getAttribute(SR_KIND_ATTR) === 'opaque' ? 'opaque' : 'identity';
  return { start, end, kind };
}
