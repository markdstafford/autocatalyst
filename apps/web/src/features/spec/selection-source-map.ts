/**
 * Map a rendered DOM selection back to a source Markdown anchor.
 *
 * Given the source markdown, the rendered document root (the "render source map" — the DOM subtree
 * carrying the `data-sr-*` runs from `spec-runs.ts`), and a DOM Range, this returns
 * `{ from, to, quotedText }` in Unicode **code-point** offsets, or `null` for an invalid selection.
 *
 * The whole job reduces to resolving the Range's two boundaries to absolute source code-point
 * offsets and slicing the source between them — so hidden Markdown syntax, soft/hard line breaks,
 * and transformed text between the boundaries are all captured automatically, and the result is
 * always the minimal source range `[from, to)` whose `quotedText` contains the selected rendered
 * characters.
 *
 * Boundary resolution:
 * - Inside an **identity** run: measured precisely (Range text length → code points), which stays
 *   correct even after Shiki splits a code line into many coloured spans.
 * - Inside an **opaque** run: snapped outward (start → run start, end → run end).
 * - Between runs or in a structural element: the nearest run in the selection's direction.
 *
 * Returns `null` when a boundary is outside the document, the range is empty/collapsed, or the
 * quoted text is whitespace-only. Front matter is never rendered, so it has no runs and can never
 * be selected.
 */
import { sliceByCodePoints, utf16IndexToCodePointOffset } from './code-points.js';
import { readRunRange, SR_START_ATTR } from './spec-runs.js';

export interface SpecAnchorCandidate {
  readonly from: number;
  readonly to: number;
  readonly quotedText: string;
}

type BoundarySide = 'start' | 'end';

export interface MapRangeOptions {
  readonly markdown: string;
  readonly documentRoot: HTMLElement;
  readonly range: Range;
}

/** Map a DOM Range inside the rendered spec document to a source anchor candidate, or null. */
export function mapRangeToSourceAnchor(options: MapRangeOptions): SpecAnchorCandidate | null {
  const { markdown, documentRoot, range } = options;
  if (range.collapsed) {
    return null;
  }
  if (!documentRoot.contains(range.startContainer) || !documentRoot.contains(range.endContainer)) {
    return null;
  }

  const from = resolveBoundary(range.startContainer, range.startOffset, 'start', documentRoot);
  const to = resolveBoundary(range.endContainer, range.endOffset, 'end', documentRoot);
  if (from === null || to === null || from >= to) {
    return null;
  }

  const quotedText = sliceByCodePoints(markdown, from, to);
  if (quotedText.trim() === '') {
    return null;
  }
  return { from, to, quotedText };
}

/**
 * Map the current window selection (a convenience for callers that have a Selection rather than a
 * Range). Uses the first range only; returns null when there is no usable selection.
 */
export function mapSelectionToSourceAnchor(
  markdown: string,
  documentRoot: HTMLElement,
  selection: Selection | null
): SpecAnchorCandidate | null {
  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }
  const range = selection.getRangeAt(0);
  return mapRangeToSourceAnchor({ markdown, documentRoot, range });
}

function resolveBoundary(
  container: Node,
  offset: number,
  side: BoundarySide,
  documentRoot: HTMLElement
): number | null {
  const run = enclosingRun(container, documentRoot);
  if (run !== null) {
    const range = readRunRange(run);
    if (range === null) {
      return null;
    }
    if (range.kind === 'opaque') {
      return side === 'start' ? range.start : range.end;
    }
    const runText = run.textContent ?? '';
    const utf16 = withinRunUtf16(run, container, offset);
    return range.start + utf16IndexToCodePointOffset(runText, utf16);
  }
  return nearestRunBoundary(container, offset, side, documentRoot);
}

/** The nearest ancestor run element of `node` within the document, or null. */
function enclosingRun(node: Node, documentRoot: HTMLElement): HTMLElement | null {
  let element: Element | null = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
  while (element !== null && element !== documentRoot) {
    if (element.hasAttribute(SR_START_ATTR)) {
      return element as HTMLElement;
    }
    element = element.parentElement;
  }
  return null;
}

/** UTF-16 length of the text from a run's start to the boundary (container, offset). */
function withinRunUtf16(run: HTMLElement, container: Node, offset: number): number {
  const range = run.ownerDocument.createRange();
  range.selectNodeContents(run);
  try {
    range.setEnd(container, offset);
  } catch {
    return 0;
  }
  return range.toString().length;
}

/**
 * Resolve a boundary that is not inside a run to the nearest run boundary in the selection's
 * direction: for the `from` side, the first run starting at or after the boundary; for the `to`
 * side, the last run ending at or before it.
 */
function nearestRunBoundary(
  container: Node,
  offset: number,
  side: BoundarySide,
  documentRoot: HTMLElement
): number | null {
  const runs = [...documentRoot.querySelectorAll<HTMLElement>(`[${SR_START_ATTR}]`)];
  if (runs.length === 0) {
    return null;
  }
  if (side === 'start') {
    for (const run of runs) {
      if (comparePointToNode(container, offset, run, 'start') <= 0) {
        return readRunRange(run)?.start ?? null;
      }
    }
    return readRunRange(runs[runs.length - 1] as HTMLElement)?.end ?? null;
  }
  let found: number | null = null;
  for (const run of runs) {
    if (comparePointToNode(container, offset, run, 'end') >= 0) {
      const range = readRunRange(run);
      if (range !== null) {
        found = range.end;
      }
    } else {
      break;
    }
  }
  if (found !== null) {
    return found;
  }
  return readRunRange(runs[0] as HTMLElement)?.start ?? null;
}

/**
 * Compare the point (container, offset) to a run's start or end boundary.
 * Returns -1 if the point is before the boundary, 0 if equal, 1 if after.
 */
function comparePointToNode(container: Node, offset: number, run: HTMLElement, which: BoundarySide): number {
  const boundary = run.ownerDocument.createRange();
  if (which === 'start') {
    boundary.setStart(run, 0);
  } else {
    boundary.setStart(run, run.childNodes.length);
  }
  boundary.collapse(true);
  try {
    // comparePoint: -1 point before range, 0 inside (equal, since collapsed), 1 after.
    return boundary.comparePoint(container, offset);
  } catch {
    return -1;
  }
}
